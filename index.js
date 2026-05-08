/**
 * bantukos-wa-bot
 * Auto-reply WhatsApp bot untuk info kos di Bali.
 * Scan QR sekali → sesi tersimpan, tidak perlu scan ulang kecuali logout.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Hapus stale Chromium lock files sebelum start supaya tidak crash
function clearChromiumLocks() {
    const sessionDir = path.join('data', 'session', 'session');
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
        const p = path.join(sessionDir, f);
        try { fs.unlinkSync(p); console.log(`🧹 Removed stale lock: ${f}`); } catch {}
    });
}
clearChromiumLocks();
const { generateReply } = require('./ai');
const {
    findListingsByLocation, formatListings,
    getById, searchAdmin, getRecentAdmin, getDbStats,
    getListingsToCheck, markWaChecked, markVerified, countPendingCheck,
    getListingByContact,
} = require('./database');

// Nomor HP pribadi owner (opsional) — format 62xxxxxxxxx tanpa + atau 0
const OWNER_PHONE = process.env.OWNER_NUMBER || null; // e.g. "6281234567890"

// Identitas bot — diisi saat ready/message_create, support @c.us dan @lid
let selfJid = null;
let selfLid = null;

// Simpan riwayat percakapan per kontak (in-memory, reset kalau bot restart)
const conversationHistory = new Map();
const MAX_HISTORY = 10; // max pesan per kontak yang disimpan

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: 'data/session' }),
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
        ],
    },
});

client.on('qr', (qr) => {
    console.log('\n📱 Scan QR code ini dengan WhatsApp kamu:\n');
    qrcode.generate(qr, { small: true });
    console.log('\nSetelah scan, sesi akan tersimpan otomatis.\n');
});

client.on('authenticated', () => {
    console.log('🔐 Berhasil authenticated!');
});

client.on('ready', () => {
    selfJid = client.info.wid._serialized;
    console.log('✅ Bantukos WA Bot siap menerima pesan!');
    console.log(`   DB  : ${process.env.BANTUKOS_DB_PATH || 'data/bantukos.db'}`);
    console.log(`   JID : ${selfJid}`);
    console.log(`   Mode: auto-reply aktif\n`);
});

client.on('auth_failure', (msg) => {
    console.error('❌ Auth gagal:', msg);
    console.error('   Hapus folder data/session/ lalu restart untuk scan QR ulang.');
});

client.on('disconnected', (reason) => {
    console.log('⚠️ Terputus:', reason);
});

function formatDetail(row) {
    const urls = (row.cloudinary_urls || '').split(',').filter(Boolean);
    const contact = row.contact ? `📞 *${row.contact}*` : '📞 —';
    const rawSnippet = (row.raw_text || '').substring(0, 300).trim();
    return [
        `📋 *Kos #${row.id}*`,
        `📍 ${row.location || '—'}`,
        `💰 ${row.price || '—'}`,
        contact,
        `🏷️ ${row.status} | ${row.source || 'facebook'}`,
        `📅 ${(row.created_at || '').substring(0, 10)}`,
        urls.length ? `\n🖼️ Foto: ${urls.slice(0, 3).join('\n')}` : '',
        row.source_url ? `\n🔗 Post asli: ${row.source_url}` : '',
        rawSnippet ? `\n📝 Info:\n${rawSnippet}` : '',
    ].filter(Boolean).join('\n');
}

async function ownerReply(msg, text) {
    return msg.reply(text);
}

function buildOwnerCheckMessage(listing) {
    const hour = new Date().getHours();
    const greeting = hour < 11 ? 'pagi' : hour < 15 ? 'siang' : hour < 18 ? 'sore' : 'malam';
    return (
        `Halo kak, selamat ${greeting} 🙏\n\n` +
        `Maaf mengganggu. Kami dari *Bantu Kos*, layanan bantu survei dan carikan penyewa kos di Bali.\n\n` +
        `Kami mendapat info ada kos di *${listing.location || 'Bali'}*` +
        (listing.price ? ` dengan harga *${listing.price}*` : '') +
        `. Apakah kamarnya saat ini masih tersedia kak?\n\n` +
        `Kami ada calon penyewa yang sedang cari kos di area tersebut dan ingin survei langsung sebelum DP.\n\n` +
        `Terima kasih banyak kak 🙏`
    );
}

// Kirim WA ke owner listing untuk cek ketersediaan (max 10/run, delay antar pesan)
async function runOwnerCheck(replyMsg, limit = 10) {
    const listings = getListingsToCheck(limit);
    if (!listings.length) {
        return ownerReply(replyMsg, '✅ Tidak ada listing dengan kontak yang belum dicek.');
    }

    await ownerReply(replyMsg, `📤 Akan kirim WA ke *${listings.length}* pemilik kos. Mohon tunggu...`);

    let sent = 0, failed = 0;
    for (const listing of listings) {
        // Mark SEBELUM kirim — cegah duplicate kalau crash
        markWaChecked(listing.id);

        const phone = listing.contact.replace(/[\s\-\+]/g, '');
        const normalized = phone.startsWith('0') ? '62' + phone.slice(1) : phone;
        const chatId = `${normalized}@c.us`;

        try {
            const text = buildOwnerCheckMessage(listing);
            await client.sendMessage(chatId, text);
            sent++;
            console.log(`📤 WA terkirim ke #${listing.id} (${normalized})`);
            // Delay 4-7 detik antar pesan supaya tidak kena spam filter
            await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
        } catch (e) {
            failed++;
            console.error(`❌ Gagal kirim ke #${listing.id}: ${e.message}`);
        }
    }

    return ownerReply(replyMsg,
        `✅ Selesai: *${sent}* terkirim, *${failed}* gagal.\n\n` +
        `Kalau owner balas & konfirmasi masih kosong, ketik:\n*verify #[id]* untuk mark sebagai terverifikasi.`
    );
}

async function handleOwnerCommand(msg, body) {
    const text = body.trim();
    const lower = text.toLowerCase();

    // cek #63 / #63 / cek id 63
    const idMatch = text.match(/(?:cek\s+)?#?(\d+)$/) || lower.match(/cek\s+id\s+(\d+)/);
    if (idMatch) {
        const row = getById(parseInt(idMatch[1]));
        if (!row) return ownerReply(msg, `❌ Listing #${idMatch[1]} tidak ditemukan.`);
        return ownerReply(msg, formatDetail(row));
    }

    // cari <keyword>
    if (lower.startsWith('cari ')) {
        const keyword = text.slice(5).trim();
        const rows = searchAdmin(keyword);
        if (!rows.length) return ownerReply(msg, `🔍 Tidak ada hasil untuk *"${keyword}"*`);
        const lines = rows.map(r => {
            const c = r.contact ? ` | 📞 ${r.contact}` : '';
            return `#${r.id} • ${r.location || '—'} • ${r.price || '—'}${c}`;
        });
        return ownerReply(msg, `🔍 *"${keyword}"* — ${rows.length} listing:\n\n${lines.join('\n')}`);
    }

    // list
    if (lower === 'list' || lower === 'listing') {
        const rows = getRecentAdmin(15);
        if (!rows.length) return ownerReply(msg, 'Database kosong.');
        const lines = rows.map(r => {
            const c = r.contact ? ` | 📞 ${r.contact}` : '';
            return `#${r.id} • ${r.location || '—'} • ${r.price || '—'}${c}`;
        });
        return ownerReply(msg, `📋 *15 Listing Terbaru*\n\n${lines.join('\n')}`);
    }

    // verify #63 — mark listing sebagai terverifikasi masih kosong
    const verifyMatch = lower.match(/^verify\s+#?(\d+)$/);
    if (verifyMatch) {
        const id = parseInt(verifyMatch[1]);
        const row = getById(id);
        if (!row) return ownerReply(msg, `❌ Listing #${id} tidak ditemukan.`);
        markVerified(id);
        return ownerReply(msg, `✅ Listing *#${id}* (${row.location}) ditandai *terverifikasi* — kamar masih kosong.`);
    }

    // check — lihat listing belum dicek
    if (lower === 'check' || lower === 'cek owner') {
        const pending = countPendingCheck();
        const preview = getListingsToCheck(5);
        const lines = preview.map(r => `#${r.id} • ${r.location || '—'} • ${r.price || '—'} • 📞 ${r.contact}`);
        return ownerReply(msg,
            `📋 *${pending}* listing punya kontak & belum di-WA.\n\n` +
            (lines.length ? `5 terbaru:\n${lines.join('\n')}\n\n` : '') +
            `Ketik *check kirim* untuk mulai kirim WA ke owner (max 10).`
        );
    }

    // check kirim — kirim WA ke owner listing
    if (lower === 'check kirim' || lower === 'check send') {
        return runOwnerCheck(msg, 10);
    }

    // stat / statistik
    if (lower === 'stat' || lower === 'statistik' || lower === 'stats') {
        const s = getDbStats();
        return ownerReply(msg,
            `📊 *Statistik DB*\n\n` +
            `Total  : ${s._total || 0}\n` +
            `Baru   : ${s.new || 0}\n` +
            `Captioned: ${s.captioned || 0}\n` +
            `Posted : ${s.posted || 0}\n` +
            `Skipped: ${s.skipped || 0}\n` +
            `Punya kontak: ${s._withContact || 0}`
        );
    }

    // help
    return ownerReply(msg,
        `🤖 *Admin Commands:*\n\n` +
        `#63 — detail listing ID 63\n` +
        `cari sesetan — cari by keyword\n` +
        `list — 15 listing terbaru\n` +
        `stat — statistik database\n` +
        `check — lihat listing belum dicek owner\n` +
        `check kirim — kirim WA ke owner (max 10)\n` +
        `verify #63 — mark listing sudah dikonfirmasi kosong`
    );
}

// Owner command: tangkap pesan yang dikirim ke diri sendiri (self-chat / note to self)
client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;

    // Capture selfLid dari dua kemungkinan format WA
    if (!selfLid) {
        if (msg.from && msg.from.endsWith('@lid')) {
            // Normal outgoing: from = LID bot
            selfLid = msg.from;
            console.log(`📌 Bot LID captured (from): ${selfLid}`);
        } else if (msg.from === selfJid && msg.to && msg.to.endsWith('@lid')) {
            // Self-chat: from = @c.us, to = LID bot sendiri
            selfLid = msg.to;
            console.log(`📌 Bot LID captured (self-chat to): ${selfLid}`);
        }
    }

    // Skip bot reply (reply selalu punya quoted message, user command tidak)
    if (msg.hasQuotedMsg) return;

    // Self-chat: to === selfJid/@c.us, atau to === selfLid/@lid,
    // atau pola khas self-chat (from=@c.us, to=@lid)
    const isSelfChat = msg.to === selfJid ||
                       (selfLid && msg.to === selfLid) ||
                       (msg.from === selfJid && msg.to && msg.to.endsWith('@lid'));
    if (!isSelfChat) return;

    const body = (msg.body || '').trim();
    if (!body) return;

    console.log(`\n👑 [OWNER-self] ${body.substring(0, 80)}`);
    try { await handleOwnerCommand(msg, body); } catch (e) { console.error('Owner cmd error:', e.message); }
});

client.on('message', async (msg) => {
    // Owner command dari nomor pribadi — resolve LID ke nomor HP dulu
    if (OWNER_PHONE && !msg.fromMe && !msg.from.endsWith('@g.us')) {
        try {
            const contact = await msg.getContact();
            if (contact.number === OWNER_PHONE) {
                const body = (msg.body || '').trim();
                if (body) {
                    console.log(`\n👑 [OWNER-personal] ${body.substring(0, 80)}`);
                    try { await handleOwnerCommand(msg, body); } catch (e) { console.error('Owner cmd error:', e.message); }
                }
                return;
            }
        } catch {}
    }

    // Skip pesan dari diri sendiri
    if (msg.fromMe) return;

    // Skip pesan dari grup
    if (msg.from.endsWith('@g.us')) return;

    // Skip pesan kosong / media tanpa caption
    const body = (msg.body || '').trim();
    if (!body) return;

    // Cek apakah pengirim adalah owner kos yang pernah kita WA — jangan di-reply bot
    try {
        const contact = await msg.getContact();
        const ownerListing = getListingByContact(contact.number);
        if (ownerListing) {
            console.log(`\n🏠 [OWNER-KOS] Reply dari owner #${ownerListing.id} (${ownerListing.contact}): ${body.substring(0, 80)}`);
            // Forward ke admin via self-chat tanpa reply ke owner
            const notif =
                `📬 *Reply dari Pemilik Kos*\n\n` +
                `Listing *#${ownerListing.id}* — ${ownerListing.location || '—'}\n` +
                `📞 ${ownerListing.contact}\n\n` +
                `💬 _"${body}"_\n\n` +
                `Kalau masih kosong → ketik *verify #${ownerListing.id}*`;
            if (selfJid) await client.sendMessage(selfJid, notif).catch(() => {});
            return; // JANGAN reply ke owner
        }
    } catch {}

    const contactId = msg.from;
    console.log(`\n📨 [${new Date().toLocaleTimeString('id-ID')}] ${contactId}: ${body.substring(0, 80)}`);

    try {
        // Ambil listing relevan dari database
        const listings = findListingsByLocation(body);
        const listingsText = formatListings(listings);

        // Ambil riwayat percakapan kontak ini
        const history = conversationHistory.get(contactId) || [];

        // Generate balasan AI
        const reply = await generateReply(body, listingsText, history);

        // Kirim balasan
        await msg.reply(reply);
        console.log(`✉️  Balas: ${reply.substring(0, 100)}${reply.length > 100 ? '...' : ''}`);

        // Simpan ke riwayat percakapan
        history.push({ role: 'user', content: body });
        history.push({ role: 'assistant', content: reply });

        // Batasi panjang history
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }
        conversationHistory.set(contactId, history);

    } catch (err) {
        console.error('⚠️ Error:', err.message);
        // Fallback reply kalau ada error
        try {
            await msg.reply('maaf lagi ada gangguan sebentar, coba WA lagi ya kak 🙏');
        } catch {}
    }
});

console.log('🚀 Memulai Bantukos WA Bot...');
client.initialize();
