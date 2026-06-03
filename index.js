/**
 * bantukos-wa-bot
 * Auto-reply WhatsApp bot untuk info kos di Bali.
 * Scan QR sekali → sesi tersimpan, tidak perlu scan ulang kecuali logout.
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
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

    // #63 — detail listing langsung
    const idMatch = lower.match(/^#(\d+)$/);
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

    // stat
    if (lower === 'stat' || lower === 'stats') {
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

    // ── fb renew ──────────────────────────────────────────────────────────────
    // Jalankan virtual desktop (noVNC) untuk renew session Facebook
    if (lower === 'fb renew' || lower === 'renew fb') {
        ownerReply(msg, '🖥️ Memulai virtual desktop...');

        // Matikan instance lama kalau ada
        require('child_process').execSync(
            'pkill -f fb-renew 2>/dev/null; pkill -f Xvfb 2>/dev/null; pkill -f x11vnc 2>/dev/null; pkill -f websockify 2>/dev/null; true',
            { stdio: 'ignore' }
        );

        // Jalankan script di background
        const proc = spawn('bash', ['/root/fb-renew.sh'], {
            detached: true,
            stdio: 'ignore',
        });
        proc.unref();

        // Tunggu script selesai start semua service
        await new Promise(r => setTimeout(r, 6000));

        return ownerReply(msg,
            `✅ *Virtual Desktop Siap!*\n\n` +
            `Buka di browser HP kamu:\n` +
            `🔗 http://43.134.47.99:6080/vnc.html\n\n` +
            `🔑 Password VNC: *bantukos*\n\n` +
            `Langkah selanjutnya:\n` +
            `1. Connect → masukkan password\n` +
            `2. Klik kanan desktop → Open Terminal\n` +
            `3. Jalankan: \`DISPLAY=:1 google-chrome-stable --no-sandbox &\`\n` +
            `4. Login ke Facebook\n` +
            `5. Di terminal: \`cd /root/bantukos-bot && DISPLAY=:1 venv/bin/python facebook.py --export-session\`\n` +
            `6. Tekan Enter → selesai! ✅\n\n` +
            `Kirim *fb stop* kalau sudah selesai.`
        );
    }

    // ── fb stop ────────────────────────────────────────────────────────────────
    // Matikan virtual desktop setelah selesai renew
    if (lower === 'fb stop') {
        require('child_process').execSync(
            'pkill -f Xvfb 2>/dev/null; pkill -f x11vnc 2>/dev/null; pkill -f websockify 2>/dev/null; pkill -f fluxbox 2>/dev/null; true',
            { stdio: 'ignore' }
        );
        return ownerReply(msg, '🛑 Virtual desktop dimatikan. Session FB baru siap dipakai bot!');
    }

    // ── owner <sub> ───────────────────────────────────────────────────────────

    // owner list — 15 listing terbaru
    if (lower === 'owner list') {
        const rows = getRecentAdmin(15);
        if (!rows.length) return ownerReply(msg, 'Database kosong.');
        const lines = rows.map(r => {
            const c = r.contact ? ` | 📞 ${r.contact}` : '';
            return `#${r.id} • ${r.location || '—'} • ${r.price || '—'}${c}`;
        });
        return ownerReply(msg, `📋 *15 Listing Terbaru*\n\n${lines.join('\n')}`);
    }

    // owner verify #63 — tandai masih kosong
    const verifyMatch = lower.match(/^owner verify\s+#?(\d+)$/);
    if (verifyMatch) {
        const id = parseInt(verifyMatch[1]);
        const row = getById(id);
        if (!row) return ownerReply(msg, `❌ Listing #${id} tidak ditemukan.`);
        markVerified(id);
        return ownerReply(msg, `✅ Listing *#${id}* (${row.location}) ditandai *terverifikasi* — kamar masih kosong.`);
    }

    // owner add <nomor> — tambah nomor ke daftar intercept manual
    const addMatch = lower.match(/^owner add\s+([\d\s\-+.]+)$/);
    if (addMatch) {
        const num = normalizePhone(addMatch[1]);
        if (!num || num.length < 8) return ownerReply(msg, `❌ Format nomor tidak valid: *${addMatch[1].trim()}*`);
        checkedOwnerNumbers.add(num);
        const listing = getListingByContact(num);
        if (listing?.contact_lid) checkedOwnerNumbers.add(listing.contact_lid);
        const lidInfo = listing?.contact_lid ? ` (LID dimuat: ${listing.contact_lid})` : '';
        return ownerReply(msg, `✅ *${num}* ditambahkan ke daftar intercept.${lidInfo}\nOwner yang balas dari nomor ini → bot akan diam & forwardkan ke sini.`);
    }

    // owner preview — contoh pesan ke owner
    if (lower === 'owner preview') {
        const sample = getListingsToCheck(1)[0] || { location: 'Sesetan, Denpasar', price: 'Rp 800.000/bulan' };
        const preview = buildOwnerCheckMessage(sample);
        return ownerReply(msg, `📋 *Contoh pesan yang akan dikirim ke owner:*\n\n${preview}`);
    }

    // owner cek — lihat listing belum dihubungi
    if (lower === 'owner cek') {
        const pending = countPendingCheck();
        const preview = getListingsToCheck(5);
        const lines = preview.map(r => `#${r.id} • ${r.location || '—'} • ${r.price || '—'} • 📞 ${r.contact}`);
        return ownerReply(msg,
            `📋 *${pending}* listing punya kontak & belum di-WA.\n\n` +
            (lines.length ? `5 terbaru:\n${lines.join('\n')}\n\n` : '') +
            `Ketik *owner kirim* untuk mulai WA ke owner (max 10).`
        );
    }

    // owner kirim — kirim WA ke owner listing
    if (lower === 'owner kirim') {
        return runOwnerCheck(msg, 10);
    }

    // owner bersihkan — hapus Docker containers, images, build cache yang tidak terpakai
    if (lower === 'owner bersihkan') {
        return runDockerCleanup(msg);
    }

    // ── lead <sub> ────────────────────────────────────────────────────────────

    // lead kirim <id> — kirim draft WA ke pencari kos
    const leadMatch = lower.match(/^lead kirim\s+(\w+)$/);
    if (leadMatch) {
        const leadId = leadMatch[1];
        const pending = loadOutreachPending();
        const lead = pending[leadId];
        if (!lead) return ownerReply(msg, `❌ Lead *${leadId}* tidak ditemukan atau sudah terkirim.`);

        const chatId = `${lead.wa_number}@c.us`;
        try {
            await client.sendMessage(chatId, lead.draft);
            delete pending[leadId];
            saveOutreachPending(pending);
            console.log(`✅ Outreach sent to ${lead.wa_number} (lead ${leadId})`);

            // Callback ke bantukos-bot untuk tandai lead sebagai contacted di DB
            const botUrl = process.env.BANTUKOS_BOT_URL || 'http://bantukos-bot:8001';
            fetch(`${botUrl}/contacted?wa=${lead.wa_number}`, { method: 'POST' })
                .catch(() => {}); // non-blocking, gagal tidak masalah

            return ownerReply(msg,
                `✅ Pesan terkirim ke *${lead.wa_number}*\n\n` +
                `_Preview:_\n${lead.draft.substring(0, 120)}...`
            );
        } catch (e) {
            console.error(`❌ Gagal kirim lead ${leadId}:`, e.message);
            return ownerReply(msg, `❌ Gagal kirim ke ${lead.wa_number}: ${e.message}`);
        }
    }

    // dm kirim <id> — auto DM Facebook via Playwright di bantukos-bot
    const dmMatch = lower.match(/^dm kirim\s+(\w+)$/);
    if (dmMatch) {
        const dmId = dmMatch[1];
        const fbPending = loadFbDmPending();
        const lead = fbPending[dmId];
        if (!lead) return ownerReply(msg, `❌ FB DM lead *${dmId}* tidak ditemukan atau sudah terkirim.`);

        await ownerReply(msg, `⏳ Membuka Facebook Messenger dan mengirim DM...`);
        const botUrl = process.env.BANTUKOS_BOT_URL || 'http://bantukos-bot:8001';
        try {
            const resp = await fetch(`${botUrl}/send-fb-dm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile_url: lead.profile_url, draft: lead.draft }),
                signal: AbortSignal.timeout(90000), // 90 detik — Playwright butuh waktu
            });
            if (resp.ok) {
                delete fbPending[dmId];
                saveFbDmPending(fbPending);
                console.log(`✅ FB DM sent (lead ${dmId}) → ${lead.profile_url}`);
                return ownerReply(msg, `✅ *DM Facebook terkirim!*\n\nPesan sudah dikirim ke:\n${lead.profile_url}`);
            } else {
                const errText = await resp.text();
                return ownerReply(msg, `❌ Gagal kirim FB DM: ${errText}`);
            }
        } catch (e) {
            return ownerReply(msg, `❌ Gagal hubungi bot: ${e.message}`);
        }
    }

    // ── help ──────────────────────────────────────────────────────────────────

    // owner flow — panduan alur owner
    if (lower === 'owner flow') {
        return ownerReply(msg,
            `📋 *Alur Cek Owner Kos*\n\n` +
            `1️⃣ *owner cek* — lihat siapa yang belum dihubungi\n` +
            `2️⃣ *owner kirim* — bot WA semua owner (max 10)\n` +
            `3️⃣ Owner balas → bot diam, forward ke sini\n` +
            `4️⃣a Balasan jelas ("masih ada" dll) → *auto-verify* otomatis ✅\n` +
            `4️⃣b Balasan ambigu → ketik *owner verify #id*\n\n` +
            `*WA manual ke owner?*\n` +
            `→ owner add 081234567890\n` +
            `→ kalau owner konfirmasi kosong, ketik owner verify #id\n\n` +
            `Ketik *help* untuk semua command.`
        );
    }

    // help — semua command
    return ownerReply(msg,
        `🤖 *Admin Commands*\n\n` +
        `📂 *Data Listing*\n` +
        `• owner list — 15 listing terbaru\n` +
        `• cari sesetan — cari by keyword\n` +
        `• #34 — detail listing #34\n` +
        `• stat — statistik database\n\n` +
        `🔧 *Server*\n` +
        `• fb renew — buka virtual desktop untuk renew FB session\n` +
        `• fb stop — matikan virtual desktop\n\n` +
        `✉️ *Owner Kos*\n` +
        `• owner cek — lihat yang belum dihubungi\n` +
        `• owner preview — contoh pesan ke owner\n` +
        `• owner kirim — WA ke owner kos (max 10)\n` +
        `• owner add 08xxx — tambah nomor manual\n` +
        `• owner verify #34 — tandai kamar masih kosong\n` +
        `• owner flow — panduan alur lengkap\n\n` +
        `🎯 *Lead (Pencari Kos)*\n` +
        `• lead kirim <id> — kirim draft WA ke pencari kos\n` +
        `• dm kirim <id>   — auto DM Facebook ke lead (via bot)\n` +
        `  _(id muncul di notif outreach yang masuk)_\n\n` +
        `🖥️ *Server*\n` +
        `• owner bersihkan — hapus Docker images/cache tidak terpakai`
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

    // Skip pesan notifikasi sistem (dikirim oleh notify API) — cegah infinite loop.
    // Notifikasi selalu multi-line atau panjang; command owner selalu 1 baris pendek (< 60 char).
    if (body.includes('\n') || body.length > 60) return;

    console.log(`\n👑 [OWNER-self] ${body.substring(0, 80)}`);
    try { await handleOwnerCommand(msg, body); } catch (e) { console.error('Owner cmd error:', e.message); }
});

const OWNER_JID_FROM_ENV = process.env.OWNER_NUMBER
    ? `${process.env.OWNER_NUMBER.replace(/\D/g, '').replace(/^0/, '62')}@c.us`
    : null;

client.on('message', async (msg) => {

    // Skip pesan dari diri sendiri
    if (msg.fromMe) return;

    // Skip pesan dari grup
    if (msg.from.endsWith('@g.us')) return;

    // Skip pesan kosong / media tanpa caption
    const body = (msg.body || '').trim();
    if (!body) return;

    // Admin command: pesan dari nomor OWNER_NUMBER ke bot
    if (OWNER_JID_FROM_ENV && msg.from === OWNER_JID_FROM_ENV) {
        console.log(`\n👑 [OWNER-incoming] ${body.substring(0, 80)}`);
        try { await handleOwnerCommand(msg, body); } catch (e) { console.error('Owner cmd error:', e.message); }
        return;
    }

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

// ── Docker cleanup ───────────────────────────────────────────────────────────
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

async function runDockerCleanup(replyMsg) {
    await ownerReply(replyMsg, '🧹 Mulai bersihkan disk Docker...');

    let docker;
    try {
        const Docker = require('dockerode');
        docker = new Docker({ socketPath: '/var/run/docker.sock' });
    } catch (e) {
        return ownerReply(replyMsg,
            `❌ Docker tidak tersedia: ${e.message}\n` +
            `Pastikan /var/run/docker.sock di-mount di Coolify (Volumes tab).`
        );
    }

    function fmtBytes(b) {
        if (!b) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
        return (b / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    const lines = [];
    let totalSaved = 0;

    try {
        const r = await docker.pruneContainers();
        const n = r.ContainersDeleted?.length || 0;
        const s = r.SpaceReclaimed || 0;
        totalSaved += s;
        lines.push(`🗑️ Containers berhenti: ${n} dihapus (${fmtBytes(s)})`);
    } catch (e) { lines.push(`⚠️ Containers: ${e.message}`); }

    try {
        const r = await docker.pruneImages({ filters: JSON.stringify({ dangling: ['false'] }) });
        const n = r.ImagesDeleted?.length || 0;
        const s = r.SpaceReclaimed || 0;
        totalSaved += s;
        lines.push(`🖼️ Images tidak terpakai: ${n} dihapus (${fmtBytes(s)})`);
    } catch (e) { lines.push(`⚠️ Images: ${e.message}`); }

    try {
        const r = await docker.pruneBuildCache();
        const s = r.SpaceReclaimed || 0;
        totalSaved += s;
        lines.push(`🔨 Build cache: ${fmtBytes(s)} dibersihkan`);
    } catch (e) { lines.push(`⚠️ Build cache: ${e.message}`); }

    let diskInfo = '';
    try {
        const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\" used)\"}'");
        diskInfo = `\n💾 Disk sekarang: *${stdout.trim()}*`;
    } catch {}

    return ownerReply(replyMsg,
        `✅ *Selesai! ~${fmtBytes(totalSaved)} dikosongkan*\n\n` +
        lines.join('\n') + diskInfo
    );
}

// ── Outreach pending store ────────────────────────────────────────────────────
const OUTREACH_PENDING_FILE = path.join('data', 'outreach_pending.json');
const FB_DM_PENDING_FILE    = path.join('data', 'fb_dm_pending.json');

function loadOutreachPending() {
    try { return JSON.parse(fs.readFileSync(OUTREACH_PENDING_FILE, 'utf8')); }
    catch { return {}; }
}
function saveOutreachPending(data) {
    try { fs.writeFileSync(OUTREACH_PENDING_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('Failed to save outreach pending:', e.message); }
}
function loadFbDmPending() {
    try { return JSON.parse(fs.readFileSync(FB_DM_PENDING_FILE, 'utf8')); }
    catch { return {}; }
}
function saveFbDmPending(data) {
    try { fs.writeFileSync(FB_DM_PENDING_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('Failed to save fb_dm pending:', e.message); }
}

// ── HTTP Notify API ──────────────────────────────────────────────────────────
// POST /notify  { "message": "...", "system": bool, "outreach_lead": {id, wa_number, draft} }
//
// system: true  → kirim ke OWNER_NOTIFY_NUMBER (disk alert, dll.)
// outreach_lead → simpan lead; owner bisa reply "kirim outreach <id>" untuk kirim ke client
// default       → kirim ke selfJid (Saved Messages)
const http = require('http');
const NOTIFY_PORT = parseInt(process.env.NOTIFY_PORT || '3001');
const OWNER_JID = `${(process.env.OWNER_NUMBER || '').replace(/\D/g, '')}@c.us`;

// Nomor tujuan notifikasi — bisa beda dari bot number supaya ada sound
const _notifyNum = (process.env.OWNER_NOTIFY_NUMBER || '').replace(/\D/g, '').replace(/^0/, '62');
const NOTIFY_TARGET_JID = _notifyNum ? `${_notifyNum}@c.us` : null;

// Queue untuk notify agar sendMessage() tidak memblokir HTTP response
const _notifyQueue = [];
let _notifyProcessing = false;

async function _processNotifyQueue() {
    if (_notifyProcessing) return;
    _notifyProcessing = true;
    while (_notifyQueue.length > 0) {
        const { target, message } = _notifyQueue.shift();
        try {
            await client.sendMessage(target, message);
            console.log(`🔔 Notif → ${target}: ${message.substring(0, 60)}`);
        } catch (e) {
            console.error('Notify send error:', e.message);
        }
        // Jeda kecil antar pesan supaya WA tidak throttle
        await new Promise(r => setTimeout(r, 500));
    }
    _notifyProcessing = false;
}

const notifyServer = http.createServer((req, res) => {
    // GET /kos/:id — lookup kos dari DB untuk admin SupportKos
    const kosMatch = req.url.match(/^\/kos\/(\d+)$/);
    if (req.method === 'GET' && kosMatch) {
        const row = getById(parseInt(kosMatch[1]));
        res.writeHead(row ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(row || { error: 'Not found' }));
        return;
    }

    if (req.method !== 'POST' || req.url !== '/notify') {
        res.writeHead(404); res.end('Not Found'); return;
    }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
        try {
            const parsed = JSON.parse(body);
            const { message, system, outreach_lead, targetWa } = parsed;
            if (!message) { res.writeHead(400); res.end('missing message'); return; }
            if (!selfJid) { res.writeHead(503); res.end('WA not ready'); return; }

            // Simpan pending WA outreach lead
            if (outreach_lead?.id && outreach_lead?.wa_number && outreach_lead?.draft) {
                const pending = loadOutreachPending();
                pending[outreach_lead.id] = {
                    wa_number: outreach_lead.wa_number,
                    draft: outreach_lead.draft,
                    created_at: new Date().toISOString(),
                };
                saveOutreachPending(pending);
                console.log(`📋 Outreach lead saved: ${outreach_lead.id} → ${outreach_lead.wa_number}`);
            }

            // Simpan pending FB DM lead
            const fb_dm_lead = parsed.fb_dm_lead;
            if (fb_dm_lead?.id && fb_dm_lead?.profile_url && fb_dm_lead?.draft) {
                const fbPending = loadFbDmPending();
                fbPending[fb_dm_lead.id] = {
                    profile_url: fb_dm_lead.profile_url,
                    draft: fb_dm_lead.draft,
                    created_at: new Date().toISOString(),
                };
                saveFbDmPending(fbPending);
                console.log(`📋 FB DM lead saved: ${fb_dm_lead.id} → ${fb_dm_lead.profile_url}`);
            }

            // Respond 200 segera — jangan tunggu sendMessage() selesai
            res.writeHead(200); res.end('ok');

            // Tentukan target penerima:
            // 1. targetWa eksplisit (mis. dari SupportKos publish ke client) → pakai itu
            // 2. system: true → kirim ke OWNER_NOTIFY_NUMBER
            // 3. default → kirim ke akun bot sendiri (selfJid)
            let target;
            const cleanTarget = String(targetWa || '').replace(/\D/g, '');
            if (cleanTarget.length >= 10 && cleanTarget.length <= 15) {
                target = cleanTarget + '@c.us';
                console.log(`📤 Notify → client ${cleanTarget}`);
            } else if (system && NOTIFY_TARGET_JID) {
                target = NOTIFY_TARGET_JID;
            } else {
                target = selfJid;
            }
            _notifyQueue.push({ target, message });
            _processNotifyQueue();
        } catch (e) {
            console.error('Notify error:', e.message);
            res.writeHead(500); res.end(e.message);
        }
    });
});
notifyServer.listen(NOTIFY_PORT, () => {
    console.log(`🔔 Notify API siap di port ${NOTIFY_PORT}`);
});

console.log('🚀 Memulai Bantukos WA Bot...');
client.initialize();
