# Bantukos WA Bot

Auto-reply WhatsApp untuk info kos Bali. Bot berjalan 24 jam, menjawab pertanyaan kos saat kamu tidur.

## Setup Awal (sekali saja)

### 1. Isi .env
```bash
cp .env.example .env
# edit .env, isi OPENAI_API_KEY
```

### 2. Deploy ke Coolify
- Add service baru → Docker Compose → repo ini
- Set env vars di Coolify:
  - `OPENAI_API_KEY` = API key OpenAI
  - `BANTUKOS_DB_PATH` = `data/bantukos.db`
  - `OWNER_NAME` = nama kamu (misal: Yuga)

### 3. Scan QR Code (pertama kali)
Setelah deploy, buka **Logs** container di Coolify. QR code akan muncul di log.

Scan QR pakai WhatsApp di HP kamu:
- WA → **⋮** → **Linked Devices** → **Link a Device** → scan QR

Setelah scan, sesi tersimpan di `data/session/` — tidak perlu scan ulang kecuali logout manual.

---

## Cara Kerja

1. Ada yang WA nomor kamu → bot auto-reply dalam hitungan detik
2. Bot cari listing yang relevan dari database bantukos
3. OpenAI generate balasan natural berdasarkan listing yang ada
4. Riwayat percakapan disimpan per kontak (max 10 pesan terakhir)

**Contoh flow:**
```
Customer : "halo, ada kos di sesetan ga?"
Bot      : "ada nih kak di sesetan, sekitar 750rb dapet yang AC wifi. 
            kalau mau info lebih lanjut bisa tanya-tanya di sini"

Customer : "ada kamar mandi dalamnya?"
Bot      : "ada kak, yang 750rb itu udah include kamar mandi dalam sama parkir motor"
```

---

## Reset Session (kalau perlu scan ulang)

```bash
# Di server
docker exec CONTAINER_ID rm -rf data/session
docker restart CONTAINER_ID
# Lalu scan QR di log Coolify lagi
```

---

## Monitor Log

Di Coolify → klik container → **Logs**. Setiap pesan masuk dan balasan bot akan muncul di sana.
