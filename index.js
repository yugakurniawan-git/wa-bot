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
const { findListingsByLocation, formatListings, getById, searchAdmin, getRecentAdmin, getDbStats } = require('./database');

// Nomor HP pemilik (tanpa +, misal: 628123456789) — set di .env sebagai OWNER_NUMBER
const OWNER_NUMBER = process.env.OWNER_NUMBER ? `${process.env.OWNER_NUMBER}@c.us` : null;

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
    console.log('✅ Bantukos WA Bot siap menerima pesan!');
    console.log(`   DB  : ${process.env.BANTUKOS_DB_PATH || 'data/bantukos.db'}`);
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
        rawSnippet ? `\n📝 Info:\n${rawSnippet}` : '',
    ].filter(Boolean).join('\n');
}

async function handleOwnerCommand(msg, body) {
    const text = body.trim();
    const lower = text.toLowerCase();

    // cek #63 / #63 / cek id 63
    const idMatch = text.match(/(?:cek\s+)?#?(\d+)$/) || lower.match(/cek\s+id\s+(\d+)/);
    if (idMatch) {
        const row = getById(parseInt(idMatch[1]));
        if (!row) return msg.reply(`❌ Listing #${idMatch[1]} tidak ditemukan.`);
        return msg.reply(formatDetail(row));
    }

    // cari <keyword>
    if (lower.startsWith('cari ')) {
        const keyword = text.slice(5).trim();
        const rows = searchAdmin(keyword);
        if (!rows.length) return msg.reply(`🔍 Tidak ada hasil untuk *"${keyword}"*`);
        const lines = rows.map(r => {
            const c = r.contact ? ` | 📞 ${r.contact}` : '';
            return `#${r.id} • ${r.location || '—'} • ${r.price || '—'}${c}`;
        });
        return msg.reply(`🔍 *"${keyword}"* — ${rows.length} listing:\n\n${lines.join('\n')}`);
    }

    // list
    if (lower === 'list' || lower === 'listing') {
        const rows = getRecentAdmin(15);
        if (!rows.length) return msg.reply('Database kosong.');
        const lines = rows.map(r => {
            const c = r.contact ? ` | 📞 ${r.contact}` : '';
            return `#${r.id} • ${r.location || '—'} • ${r.price || '—'}${c}`;
        });
        return msg.reply(`📋 *15 Listing Terbaru*\n\n${lines.join('\n')}`);
    }

    // stat / statistik
    if (lower === 'stat' || lower === 'statistik' || lower === 'stats') {
        const s = getDbStats();
        return msg.reply(
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
    return msg.reply(
        `🤖 *Admin Commands:*\n\n` +
        `#63 — detail listing ID 63\n` +
        `cek #63 — sama\n` +
        `cari sesetan — cari by keyword\n` +
        `list — 15 listing terbaru\n` +
        `stat — statistik database`
    );
}

client.on('message', async (msg) => {
    // DEBUG: log semua pengirim supaya bisa verifikasi OWNER_NUMBER
    if (!msg.fromMe && !msg.from.endsWith('@g.us')) {
        console.log(`📬 from=${msg.from} | OWNER_NUMBER set=${OWNER_NUMBER} | match=${msg.from === OWNER_NUMBER}`);
    }

    // Owner command mode
    if (OWNER_NUMBER && msg.from === OWNER_NUMBER) {
        const body = (msg.body || '').trim();
        if (body) {
            console.log(`\n👑 [OWNER] ${body.substring(0, 80)}`);
            try { await handleOwnerCommand(msg, body); } catch (e) { console.error('Owner cmd error:', e.message); }
        }
        return;
    }

    // Skip pesan dari diri sendiri
    if (msg.fromMe) return;

    // Skip pesan dari grup
    if (msg.from.endsWith('@g.us')) return;

    // Skip pesan kosong / media tanpa caption
    const body = (msg.body || '').trim();
    if (!body) return;

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
