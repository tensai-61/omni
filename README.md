# Turnuva ve Lig Yöneticisi

## Çalıştırma

Node.js 22.5 veya daha yenisi gerekir (`node:sqlite`).

```bash
npm install
cp .env.example .env
npm start
```

Uygulama varsayılan olarak `http://127.0.0.1:3000` adresinde açılır. `TURSO_DATABASE_URL` ve `TURSO_AUTH_TOKEN` birlikte tanımlıysa veri Turso üzerinde tutulur; ikisi de boşsa yerel SQLite dosyası kullanılır. Buluta alma adımları `DEPLOY.md` dosyasındadır. Ortam değişkenlerinin adları `.env.example` dosyasındadır; değerler repoya yazılmaz.

## Ters vekil

**Ters vekil arkasında `TRUST_PROXY=1` zorunludur.** Aksi halde bütün istekler tek bir soket IP'si (çoğunlukla vekilin adresi) gibi görünür. Hız sınırları ve doğrulama kotası herkes için ortak olur; bir kişi diğerlerinin doğrulamasını kilitleyebilir.

`TRUST_PROXY=1` iken istemci adresi `X-Forwarded-For` başlığının **en sağındaki** geçerli adrestir. Soldaki değer istemciden gelebilir, kullanılmaz. Aynı bayrak, vekilin eklediği `X-Forwarded-Proto: https` değerinin HTTPS sayılması için de gerekir.

Hız sınırları IP ve e-posta bazındadır; herkes için ortak bir sayaç yoktur. Çok büyük bir botnet yine de scrypt kuyruğunu meşgul edebilir. Bu durumda meşru kullanıcı ara sıra kısa bir ret görebilir; tek bir IP kuyruğun tamamını tutamaz.

## Lisans

Kullanım koşulları kökteki `LICENSE` dosyasındadır. Yazılım WTS STUDIOS’a aittir; kişisel ve ticari olmayan, değiştirilmemiş kullanım dışında yazılı izin gerekir.
