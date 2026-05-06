/**
 * bantukos-wa-bot
 * Auto-reply WhatsApp bot untuk info kos di Bali.
 * Scan QR sekali → sesi tersimpan, tidak perlu scan ulang kecuali logout.
 */
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { generateReply } = require('./ai');
const { findListingsByLocation, formatListings } = require('./database');

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

client.on('message', async (msg) => {
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
