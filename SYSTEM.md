# Bantukos WA Bot — Arsitektur & Alur

## Peran Bot Ini

Bot WhatsApp gateway untuk Bantukos. Dua fungsi utama:
1. **Balas customer** yang tanya tentang kos (auto-reply listing dari DB)
2. **Terima notifikasi** dari `bantukos-bot` (outreach leads, system alerts)

---

## Nomor WA

- **WA Bisnis** = nomor WhatsApp bot ini sendiri (customer chat di sini, owner lihat Saved Messages di sini)
- **WA Pribadi owner** = `OWNER_NUMBER` env var = nomor pribadi Yuga

---

## Routing Notifikasi `/notify`

| Payload | Target | Kapan |
|---|---|---|
| `{ message, system: false }` | `selfJid` = **Saved Messages WA Bisnis** | Outreach lead baru — owner buka WA Bisnis untuk lihat & action |
| `{ message, system: true }` | `OWNER_NOTIFY_NUMBER` = **WA Pribadi** | Alert kritis (token expired, disk full, dll) |

**JANGAN ubah routing ini.** Lead ke selfJid adalah intentional — owner manage dari WA Bisnis.

---

## Alur Lead Outreach

1. `bantukos-bot` detect "cari kos" di FB → POST `/notify` dengan `outreach_lead`
2. Lead disimpan di `data/outreach_pending.json`
3. Pesan muncul di **Saved Messages WA Bisnis** (selfJid)
4. Owner buka WA Bisnis → lihat lead → reply **"kirim outreach `<id>`"**
5. Bot kirim draft ke nomor WA client

---

## Owner Commands (dari WA Pribadi)

```
owner list              — 15 listing terbaru di DB
owner cari <kata>       — cari listing
owner detail #<id>      — detail listing
owner verify #<id>      — tandai masih kosong
owner add <nomor>       — tambah nomor ke intercept list
owner kirim wa          — kirim WA ke pemilik kos (cek ketersediaan)
owner bersihkan         — bersihkan disk Docker (images, cache)
```

---

## Environment Variables

| Var | Fungsi |
|---|---|
| `OWNER_NUMBER` | WA Pribadi owner — untuk terima command dan `OWNER_JID` |
| `OWNER_NOTIFY_NUMBER` | Target system alert (biasanya sama dengan OWNER_NUMBER) |
| `NOTIFY_PORT` | Default: 3001 |

---

## Known Issues / History

- **2026-05-19**: Leads tidak sampai ke owner → ternyata selfJid (Saved Messages WA Bisnis) adalah by design, owner harus buka WA Bisnis
- **2026-05-19**: WA bot gabung coolify network agar bisa di-reach dari bantukos-bot via DNS `bantukos-wa-bot:3001`
- **2026-05-19**: Tambah `owner bersihkan` command untuk Docker cleanup via WA
