const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.BANTUKOS_DB_PATH || 'data/bantukos.db';

function getDb() {
    return new Database(DB_PATH, { readonly: true });
}

function getDbWrite() {
    return new Database(DB_PATH);
}

/**
 * Cari listing berdasarkan lokasi yang disebutkan user.
 * Kembalikan max 3 listing paling relevan.
 */
function findListingsByLocation(locationQuery) {
    try {
        const db = getDb();

        // Normalize query jadi kata-kata
        const words = (locationQuery || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);

        if (words.length === 0) {
            // Kalau tidak ada lokasi spesifik, ambil listing terbaru yang sudah posted
            const rows = db.prepare(`
                SELECT id, location, price, caption
                FROM posts
                WHERE status = 'posted' AND location IS NOT NULL AND location != ''
                ORDER BY id DESC LIMIT 3
            `).all();
            db.close();
            return rows;
        }

        // Cari yang location-nya mengandung salah satu kata dari query
        const conditions = words.map(() => `LOWER(location) LIKE ?`).join(' OR ');
        const params = words.map(w => `%${w}%`);

        const rows = db.prepare(`
            SELECT id, location, price, caption
            FROM posts
            WHERE status = 'posted' AND (${conditions})
            ORDER BY id DESC LIMIT 3
        `).all(...params);

        db.close();
        return rows;
    } catch (err) {
        console.error('DB error:', err.message);
        return [];
    }
}

/**
 * Format listing jadi teks ringkas untuk AI.
 */
function formatListings(listings) {
    if (!listings || listings.length === 0) return 'Tidak ada listing tersedia saat ini.';

    return listings.map((l, i) => {
        const caption = (l.caption || '').substring(0, 120).replace(/\n/g, ' ');
        const price = l.price || 'harga hubungi owner';
        const loc = l.location || 'Bali';
        return `${i + 1}. Lokasi: ${loc} | Harga: ${price}\n   Info: ${caption}`;
    }).join('\n\n');
}

/**
 * Admin: detail lengkap satu listing by ID
 */
function getById(id) {
    try {
        const db = getDb();
        const row = db.prepare(`
            SELECT id, location, price, contact, source, status,
                   raw_text, caption, cloudinary_urls, created_at,
                   COALESCE(source_url, '') as source_url
            FROM posts WHERE id = ?
        `).get(id);
        db.close();
        return row || null;
    } catch (err) {
        console.error('DB error:', err.message);
        return null;
    }
}

/**
 * Admin: cari listing by keyword (lokasi / raw_text), max 10
 */
function searchAdmin(keyword) {
    try {
        const db = getDb();
        const q = `%${keyword.toLowerCase()}%`;
        const rows = db.prepare(`
            SELECT id, location, price, contact, source, status
            FROM posts
            WHERE LOWER(location) LIKE ? OR LOWER(raw_text) LIKE ?
            ORDER BY id DESC LIMIT 10
        `).all(q, q);
        db.close();
        return rows;
    } catch (err) {
        console.error('DB error:', err.message);
        return [];
    }
}

/**
 * Admin: listing terbaru dengan kontak, max 15
 */
function getRecentAdmin(limit = 15) {
    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT id, location, price, contact, source, status
            FROM posts ORDER BY id DESC LIMIT ?
        `).all(limit);
        db.close();
        return rows;
    } catch (err) {
        console.error('DB error:', err.message);
        return [];
    }
}

/**
 * Admin: statistik DB
 */
function getDbStats() {
    try {
        const db = getDb();
        const rows = db.prepare(`SELECT status, COUNT(*) as count FROM posts GROUP BY status`).all();
        const total = db.prepare(`SELECT COUNT(*) as count FROM posts`).get();
        const withContact = db.prepare(`SELECT COUNT(*) as count FROM posts WHERE contact IS NOT NULL AND contact != ''`).get();
        db.close();
        const stats = {};
        rows.forEach(r => { stats[r.status] = r.count; });
        stats._total = total.count;
        stats._withContact = withContact.count;
        return stats;
    } catch (err) {
        console.error('DB error:', err.message);
        return {};
    }
}

/**
 * Admin: listing dengan kontak yang belum pernah di-WA untuk cek ketersediaan
 */
function getListingsToCheck(limit = 10) {
    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT id, location, price, contact, source_url
            FROM posts
            WHERE contact IS NOT NULL AND contact != ''
              AND wa_checked_at IS NULL
              AND status NOT IN ('skipped')
            ORDER BY id DESC LIMIT ?
        `).all(limit);
        db.close();
        return rows;
    } catch (err) {
        console.error('DB error:', err.message);
        return [];
    }
}

/**
 * Admin: tandai listing sudah di-WA (sebelum kirim, untuk cegah duplicate)
 */
function markWaChecked(id) {
    try {
        const db = getDbWrite();
        db.prepare(`UPDATE posts SET wa_checked_at = datetime('now') WHERE id = ?`).run(id);
        db.close();
    } catch (err) {
        console.error('DB markWaChecked error:', err.message);
    }
}

/**
 * Admin: tandai listing sudah diverifikasi masih kosong oleh owner
 */
function markVerified(id) {
    try {
        const db = getDbWrite();
        db.prepare(`UPDATE posts SET verified = 1 WHERE id = ?`).run(id);
        db.close();
    } catch (err) {
        console.error('DB markVerified error:', err.message);
    }
}

/**
 * Admin: hitung listing pending untuk dicek
 */
function countPendingCheck() {
    try {
        const db = getDb();
        const row = db.prepare(`
            SELECT COUNT(*) as count FROM posts
            WHERE contact IS NOT NULL AND contact != ''
              AND wa_checked_at IS NULL AND status NOT IN ('skipped')
        `).get();
        db.close();
        return row.count;
    } catch (err) {
        return 0;
    }
}

module.exports = {
    findListingsByLocation, formatListings,
    getById, searchAdmin, getRecentAdmin, getDbStats,
    getListingsToCheck, markWaChecked, markVerified, countPendingCheck,
};
