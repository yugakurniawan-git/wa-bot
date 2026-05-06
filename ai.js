const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OWNER_NAME = process.env.OWNER_NAME || 'owner';

const SYSTEM_PROMPT = `Kamu adalah asisten WhatsApp untuk jasa kos di Bali bernama Bantu Kos.
Kamu membantu orang yang WA untuk tanya-tanya soal kos yang tersedia di Bali.

CARA BALAS:
- Santai dan natural seperti orang biasa, bukan robot atau agen properti
- Bahasa Indonesia sehari-hari, boleh singkat 1-3 kalimat
- Jangan sebut dirimu AI atau bot
- Pakai "kak" untuk sapaan kalau perlu, tapi tidak harus di setiap kalimat
- Boleh pakai 1 emoji kalau relevan, tidak harus

KALAU ADA LISTING YANG COCOK:
- Sebutkan lokasi dan harga secara singkat
- Kalau ada fasilitas menarik, sebut 1-2 saja
- Akhiri dengan tawaran untuk info lebih lanjut

KALAU TIDAK ADA LISTING / PERTANYAAN RUMIT:
- Bilang lagi dicari dulu atau ${OWNER_NAME} lagi istirahat tapi nanti dibalas
- Jangan kasih info palsu

TENTANG JASA LAIN:
- Bantu Kos juga punya jasa survei/pengecekan kos (Rp 150.000) buat yang mau pastiin kondisi kos sebelum DP
- Sebutin ini kalau relevan, misalnya kalau orang tanya mau lihat dulu kondisinya`;

/**
 * Generate balasan AI berdasarkan pesan user dan listing yang relevan.
 */
async function generateReply(userMessage, listingsText, conversationHistory = []) {
    const messages = [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nLISTING TERSEDIA SEKARANG:\n${listingsText}` },
        ...conversationHistory.slice(-8), // max 8 pesan terakhir sebagai konteks
        { role: 'user', content: userMessage }
    ];

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 200,
        temperature: 0.85,
    });

    return response.choices[0].message.content.trim();
}

module.exports = { generateReply };
