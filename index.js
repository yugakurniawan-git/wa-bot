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
const {
    getById, searchAdmin, getRecentAdmin, getDbStats,
    getListingsToCheck, markWaChecked, markVerified, countPendingCheck,
    getListingByContact, saveContactLid,
} = require('./database');

// Nomor owner kos yang sudah di-WA — in-memory untuk intercept reply cepat
// Menyimpan: normalized phone (628xxx) DAN LID WA owner (628xxx@lid)
const checkedOwnerNumbers = new Set();

function normalizePhone(n) {
    return (n || '').replace(/\D/g, '').replace(/^0/, '62');
}

// Identitas bot — diisi saat ready/message_create, support @c.us dan @lid
let selfJid = null;
let selfLid = null;
const SELF_LID_FILE = path.join('data', 'self_lid.txt');

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

client.on('ready', async () => {
    selfJid = client.info.wid._serialized;

    // 1. Load selfLid dari file (persist antar restart)
    try {
        const saved = fs.readFileSync(SELF_LID_FILE, 'utf8').trim();
        if (saved && saved.endsWith('@lid')) {
            selfLid = saved;
            console.log(`   📌 selfLid: ${selfLid} (dari file)`);
        }
    } catch {}

    // 2. Kalau belum ada, cari dari history self-chat
    if (!selfLid) {
        try {
            const selfChat = await client.getChatById(selfJid);
            const msgs = await selfChat.fetchMessages({ limit: 10 });
            for (const m of msgs) {
                if (m.fromMe && m.to && m.to.endsWith('@lid')) {
                    selfLid = m.to;
                    fs.writeFileSync(SELF_LID_FILE, selfLid);
                    console.log(`   📌 selfLid: ${selfLid} (dari history, disimpan)`);
                    break;
                }
            }
        } catch {}
    }

    // 3. Load owner numbers DAN LID dari DB ke Set
    try {
        const Database = require('better-sqlite3');
        const db = new Database(process.env.BANTUKOS_DB_PATH || 'data/bantukos.db', { readonly: true });
        const rows = db.prepare(`SELECT contact, contact_lid FROM posts WHERE wa_checked_at IS NOT NULL`).all();
        db.close();
        rows.forEach(r => {
            if (r.contact) checkedOwnerNumbers.add(normalizePhone(r.contact));
            if (r.contact_lid) checkedOwnerNumbers.add(r.contact_lid);
        });
        console.log(`   🛡️  Loaded ${checkedOwnerNumbers.size} checked owner numbers/LIDs`);
    } catch (e) {
        console.error('   ⚠️ Gagal load checked owners:', e.message);
    }

    console.log('✅ Bantukos WA Bot siap menerima pesan!');
    console.log(`   DB  : ${process.env.BANTUKOS_DB_PATH || 'data/bantukos.db'}`);
    console.log(`   JID : ${selfJid}`);
    if (!selfLid) console.log(`   ⚠️  selfLid belum diketahui — kirim 1 pesan ke self-chat untuk aktivasi\n`);
    else console.log(`   Mode: siap\n`);
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
    return (
        `Halo kak, maaf ganggu 🙏\n\n` +
        `Mau nanya kos` +
        (listing.location ? ` di *${listing.location}*` : '') +
        (listing.price ? ` yang *${listing.price}*` : '') +
        ` masih ada kamar kosong gak?\n\n` +
        `Kalau masih kosong, boleh minta info detail kamarnya kak — fasilitas, foto, dan kondisi terkini?\n\n` +
        `Terima kasih kak 🙏`
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

        const normalized = normalizePhone(listing.contact);
        checkedOwnerNumbers.add(normalized);
        const chatId = `${normalized}@c.us`;

        try {
            const text = buildOwnerCheckMessage(listing);
            const sentMsg = await client.sendMessage(chatId, text);
            // Simpan LID asli dari sentMsg.to ke memory DAN DB supaya persist antar restart
            if (sentMsg?.to) {
                checkedOwnerNumbers.add(sentMsg.to);
                if (sentMsg.to.endsWith('@lid')) saveContactLid(listing.id, sentMsg.to);
            }
            sent++;
            console.log(`📤 WA terkirim ke #${listing.id} (${normalized}) → chat=${sentMsg?.to || chatId}`);
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

    // #63 atau cek #63 atau cek id 63
    const idMatch = lower.match(/^#(\d+)$/) || lower.match(/^cek\s+#?(\d+)$/) || lower.match(/^cek\s+id\s+(\d+)$/);
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

    // check add [nomor] — manual tambah nomor ke daftar intercept
    const addMatch = lower.match(/^check add\s+([\d\s\-+.]+)$/);
    if (addMatch) {
        const num = normalizePhone(addMatch[1]);
        if (!num || num.length < 8) return ownerReply(msg, `❌ Format nomor tidak valid: *${addMatch[1].trim()}*`);
        checkedOwnerNumbers.add(num);
        // Kalau ada di DB, load juga LID-nya supaya intercept bisa match langsung
        const listing = getListingByContact(num);
        if (listing?.contact_lid) checkedOwnerNumbers.add(listing.contact_lid);
        const lidInfo = listing?.contact_lid ? ` (LID dimuat: ${listing.contact_lid})` : '';
        return ownerReply(msg, `✅ *${num}* ditambahkan ke daftar intercept.${lidInfo}\nOwner yang balas dari nomor ini → bot akan diam & forwardkan ke sini.`);
    }

    // check preview — kirim contoh pesan ke self-chat
    if (lower === 'check preview') {
        const sample = getListingsToCheck(1)[0] || { location: 'Sesetan, Denpasar', price: 'Rp 800.000/bulan' };
        const preview = buildOwnerCheckMessage(sample);
        return ownerReply(msg, `📋 *Contoh pesan yang akan dikirim ke owner:*\n\n${preview}`);
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

    // help flow — panduan alur lengkap
    if (lower === 'help flow' || lower === 'flow') {
        return ownerReply(msg,
            `📋 *Alur Cek Owner Kos*\n\n` +
            `1️⃣ *check* — lihat siapa yang belum dihubungi\n` +
            `2️⃣ *check kirim* — bot WA semua owner (max 10)\n` +
            `3️⃣ Owner balas → bot diam, forward ke sini\n` +
            `4️⃣a Balasan jelas ("masih ada" dll) → *auto-verify* otomatis ✅\n` +
            `4️⃣b Balasan ambigu → ketik *verify #id*\n\n` +
            `*WA manual ke owner?*\n` +
            `→ check add 081234567890\n` +
            `→ kalau owner konfirmasi kosong, ketik verify #id\n\n` +
            `Ketik *help* untuk semua command.`
        );
    }

    // help — semua command
    return ownerReply(msg,
        `🤖 *Admin Commands*\n\n` +
        `📂 *Data Listing*\n` +
        `• list — 15 listing terbaru\n` +
        `• cari sesetan — cari by keyword\n` +
        `• #34 — detail listing #34\n` +
        `• stat — statistik database\n\n` +
        `✉️ *Cek Owner Kos*\n` +
        `• check — lihat yang belum dicek\n` +
        `• check preview — contoh pesan ke owner\n` +
        `• check kirim — WA owner (max 10)\n` +
        `• check add 08xxx — tambah nomor manual\n\n` +
        `✅ *Verifikasi*\n` +
        `• verify #34 — tandai masih kosong\n\n` +
        `Ketik *help flow* untuk panduan alur lengkap.`
    );
}

// Owner command: tangkap pesan yang dikirim ke diri sendiri (self-chat / note to self)
client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;

    // Capture selfLid dan simpan ke file supaya persist antar restart
    if (!selfLid) {
        let captured = null;
        if (msg.from && msg.from.endsWith('@lid')) {
            captured = msg.from; // outgoing: msg.from = LID bot sendiri
        } else if (msg.from === selfJid && msg.to && msg.to.endsWith('@lid')) {
            captured = msg.to;   // self-chat: msg.from=@c.us, msg.to=selfLid@lid
        }
        if (captured) {
            selfLid = captured;
            try { fs.writeFileSync(SELF_LID_FILE, selfLid); } catch {}
            console.log(`📌 selfLid captured & saved: ${selfLid}`);
        }
    }

    // Skip bot reply (reply selalu punya quoted message, user command tidak)
    if (msg.hasQuotedMsg) return;

    // Self-chat: msg.to adalah self (dalam format @c.us atau @lid)
    const isSelfChat = msg.to === selfJid || (selfLid && msg.to === selfLid);
    if (!isSelfChat) return;

    const body = (msg.body || '').trim();
    if (!body) return;

    console.log(`\n👑 [OWNER-self] ${body.substring(0, 80)}`);
    try { await handleOwnerCommand(msg, body); } catch (e) { console.error('Owner cmd error:', e.message); }
});

client.on('message', async (msg) => {

    // Skip pesan dari diri sendiri
    if (msg.fromMe) return;

    // Skip pesan dari grup
    if (msg.from.endsWith('@g.us')) return;

    // Skip pesan kosong / media tanpa caption
    const body = (msg.body || '').trim();
    if (!body) return;

    // Cek apakah pengirim adalah owner kos yang pernah kita WA
    // Cek msg.from langsung dulu (match LID yang tersimpan di Set/DB)
    let phoneFromId = msg.from.endsWith('@c.us') ? msg.from.replace('@c.us', '') : '';
    const directMatch = checkedOwnerNumbers.has(msg.from) ||
                        (phoneFromId && checkedOwnerNumbers.has(normalizePhone(phoneFromId)));
    // Kalau tidak direct match dan format @lid, coba resolve via getContact()
    if (!directMatch && msg.from.endsWith('@lid')) {
        try {
            const contact = await msg.getContact();
            phoneFromId = contact.number || '';
            // Kalau nomor ini ternyata ada di checkedOwnerNumbers, simpan LID ke Set+DB
            if (phoneFromId && checkedOwnerNumbers.has(normalizePhone(phoneFromId))) {
                checkedOwnerNumbers.add(msg.from);
                const listing = getListingByContact(phoneFromId);
                if (listing?.id) saveContactLid(listing.id, msg.from);
            }
        } catch {}
    }
    const isOwner = directMatch ||
                    (phoneFromId && checkedOwnerNumbers.has(normalizePhone(phoneFromId))) ||
                    getListingByContact(phoneFromId);
    if (isOwner) {
        const ownerListing = typeof isOwner === 'object' ? isOwner : getListingByContact(phoneFromId);
        console.log(`\n🏠 [OWNER-KOS SILENT] ${msg.from}: ${body.substring(0, 80)}`);

        // Auto-verify: kalau owner balas dengan kata positif, langsung mark verified
        const positiveReply = /\b(masih\s+(ada|kosong|available)|ada\s+kak|ada\s+pak|ada\s+bu|ada\s+mas|iya\s+(ada|masih|kosong)|ya\s+(ada|masih)|ready|available|kosong\s*kak|masih\s*kok|oke\s*ada|ada\s+kok)\b/i;
        const autoVerified = ownerListing?.id && positiveReply.test(body);
        if (autoVerified) {
            markVerified(ownerListing.id);
            console.log(`✅ Auto-verified listing #${ownerListing.id} dari reply owner`);
        }

        const notif =
            `📬 *Reply dari Pemilik Kos*\n\n` +
            (ownerListing?.id ? `Listing *#${ownerListing.id}* — ${ownerListing.location || '—'}\n📞 ${ownerListing.contact}\n\n` : `📞 ${phoneFromId || msg.from}\n\n`) +
            `💬 _"${body}"_\n\n` +
            (autoVerified
                ? `✅ *Auto-verified!* Kamar dikonfirmasi masih kosong.`
                : ownerListing?.id ? `Kalau masih kosong → ketik *verify #${ownerListing.id}*` : '');
        if (selfJid) await client.sendMessage(selfJid, notif).catch(() => {});
        return;
    }

    // AI auto-reply dimatikan — bot diam untuk semua pesan non-owner
    console.log(`\n📨 [${new Date().toLocaleTimeString('id-ID')}] ${msg.from}: ${body.substring(0, 80)} (ignored)`);
});

console.log('🚀 Memulai Bantukos WA Bot...');
client.initialize();
