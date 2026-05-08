# Bantukos WA Bot — Panduan Admin

Bot WhatsApp untuk admin bantukos: intercept balasan owner kos, cek ketersediaan, dan kelola listing dari self-chat WA Business.

---

## Setup Awal (sekali saja)

### 1. Isi .env
```
BANTUKOS_DB_PATH=data/bantukos.db
CHROMIUM_PATH=/usr/bin/chromium
```

### 2. Deploy ke Coolify
- Add service → Docker Compose → repo ini
- **Disable auto-deploy** (penting — restart bot akan reset session)
- Set env vars di Coolify

### 3. Scan QR Code (pertama kali)
Buka **Logs** container di Coolify. Scan QR dengan WA Business di HP:
- WA → ⋮ → **Linked Devices** → **Link a Device** → scan QR

Setelah scan, sesi tersimpan di `data/session/` — tidak perlu scan ulang.

### 4. Aktivasi self-chat (pertama kali)
Setelah bot online, kirim **satu pesan apapun** ke diri sendiri dari WA Business.
Bot akan capture ID-nya dan simpan ke file — self-chat commands langsung aktif.

---

## Flow Lengkap: Cek Ketersediaan Owner Kos

```
1. Ketik: check
   → Bot tampilkan daftar owner yang belum pernah dihubungi

2. Ketik: check kirim
   → Bot WA semua owner kos (max 10, delay 4-7 detik per pesan)
   → Pesan dikirim tanpa nama brand, nada personal

3. Owner balas WA
   → Bot DIAM (tidak balas owner)
   → Bot forward ke self-chat kamu:

      📬 Reply dari Pemilik Kos
      Listing #34 — Sesetan, Denpasar
      📞 628573...
      💬 "masih ada kak, AC wifi"
      ✅ Auto-verified! Kamar dikonfirmasi masih kosong.

4a. Kalau muncul "✅ Auto-verified!"
    → Selesai, listing sudah ditandai verified di DB

4b. Kalau balasan ambigu (tidak ada "✅ Auto-verified!")
    → Ketik di self-chat: verify #34
    → Bot tandai listing sebagai verified

5. Kalau owner bilang TIDAK ada / sudah terisi
   → Tidak perlu action apapun
```

---

## Flow: WA Manual ke Owner (tanpa bot)

Kalau kamu kirim WA sendiri ke owner (bukan via `check kirim`):

```
1. Ketik di self-chat: check add 081234567890
   → Bot tambahkan nomor ke daftar intercept

2. Owner balas WA kamu
   → Bot diam, forward ke self-chat seperti biasa

3. Kalau owner konfirmasi masih kosong
   → Ketik: verify #34
```

---

## Semua Admin Commands

Semua command diketik di **self-chat WA Business** (kirim pesan ke nomor sendiri).

### Lihat Data Listing

| Command | Fungsi |
|---------|--------|
| `list` | 15 listing terbaru (ID, lokasi, harga, kontak) |
| `cari sesetan` | Cari listing berdasarkan keyword |
| `#34` | Detail lengkap listing #34 (foto, kontak, link post) |
| `stat` | Statistik database (total, posted, captioned, dll) |

### Cek Owner Kos

| Command | Fungsi |
|---------|--------|
| `check` | Lihat jumlah & preview listing yang belum dicek owner |
| `check preview` | Lihat contoh pesan yang akan dikirim ke owner |
| `check kirim` | Kirim WA ke owner (max 10, otomatis beri jeda) |
| `check add 081234567890` | Manual tambah nomor ke daftar intercept |

### Verifikasi

| Command | Fungsi |
|---------|--------|
| `verify #34` | Tandai listing #34 masih kosong (dikonfirmasi owner) |

### Tips Penggunaan

- **Auto-verify aktif** — kalau owner balas "masih ada", "ada kak", "ready", "available" → bot otomatis verify, tidak perlu ketik `verify`
- **Kata trigger auto-verify:** masih ada, masih kosong, ada kak/pak/bu/mas, iya ada, ya ada, ready, available, ada kok
- `check kirim` bisa dijalankan berkali-kali — hanya kirim ke owner yang **belum pernah dihubungi**
- Setelah bot restart, daftar intercept di-reload dari DB otomatis

---

## Notifikasi Owner Balas

Format notif di self-chat:

```
📬 Reply dari Pemilik Kos

Listing #34 — Sesetan, Denpasar Selatan
📞 6285730399903

💬 "iya masih ada kak, bisa survei kapanpun"

✅ Auto-verified! Kamar dikonfirmasi masih kosong.
```

Kalau tidak auto-verified:
```
💬 "ada yang mau tanya dulu ya"

Kalau masih kosong → ketik verify #34
```

---

## Reset Session (kalau perlu scan ulang)

```bash
# Di Coolify → terminal container
rm -rf data/session data/self_lid.txt
# Lalu restart container dan scan QR di log
```

---

## Monitor Log

Coolify → klik container → **Logs**

| Log | Artinya |
|-----|---------|
| `👑 [OWNER-self] cari sesetan` | Admin ketik command di self-chat |
| `🏠 [OWNER-KOS SILENT] 628xxx` | Owner kos balas, diintercept |
| `✅ Auto-verified #34` | Listing auto-diverify dari reply owner |
| `📤 WA terkirim ke #34` | Bot berhasil WA owner |
| `📨 [12.35] 628xxx: ... (ignored)` | Pesan masuk, diabaikan (AI off) |
