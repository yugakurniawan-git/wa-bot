const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.BANTUKOS_DB_PATH || 'data/bantukos.db';

function getDb() {
    return new Database(DB_PATH, { readonly: true });
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

module.exports = { findListingsByLocation, formatListings };
