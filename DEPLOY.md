# Omni buluta alma

Bu dosya Zeyd içindir. Repo indirmek, bilgisayara `.env` koymak veya `.db` dosyası taşımak gerekmez. Eski yerel veritabanı taşınmaz; hesaplar yeni veritabanında yeniden açılır.

Ücretli plana veya kredi kartına gerek yok. Turso ücretsiz plan ve Render ücretsiz web servisi yeter.

Hiçbir gizli değeri bu dosyaya, repoya, bir iş akışı günlüğüne veya hata mesajına yazmayın.

## 1. Turso veritabanı

1. Turso hesabı açın (ücretsiz plan, kart istemez).
2. Tek bir veritabanı oluşturun. Adı size kalmış; örnek olarak `omni` kullanılabilir.
3. Bu veritabanı için **yalnızca bu veritabanına bağlı** bir jeton üretin. Hesap geneli (account-wide) jeton kullanmayın.
4. Daha önce üretilmiş bir jeton varsa onu iptal edin ve yenisini kullanın. Eski jetonu Render’a yapıştırmayın.
5. Bağlantı adresini (`libsql://…`) ve jetonu bir yere not edin. Bunlar yalnızca Render ve GitHub gizli ayarlarına girer.

Turso ücretsiz planda her `COMMIT` için yedek tutar ve son **1 gün** içinde istediğiniz ana dönebilirsiniz (point-in-time restore). Bu, kart gerektirmez. Geri dönüş mevcut veritabanını yerinde geri sarmaz; yeni bir veritabanı oluşturur. Silinmiş bir veritabanını ücretsiz plan geri getirmez.

## 2. Render

1. Render’da kart eklemeden ücretsiz hesap açın.
2. Bu repoyu bağlayıp `render.yaml` içindeki web servisini oluşturun. Plan `free`, Node 22, sağlık yolu `/healthz` dosyada yazılıdır. Servisi elle ayrıca kurmayın; blueprint aynı ayarı verir.
3. Render ortam ayarlarına şunları girin. `render.yaml` içinde `sync: false` olanların değeri repoda yoktur; panoya siz yazarsınız.

| Ad | Ne yazılır |
| --- | --- |
| `NODE_ENV` | `production` (blueprint’te durur) |
| `OMNI_HOSTED` | `1` (blueprint’te durur) |
| `HOST` | `0.0.0.0` (blueprint’te durur) |
| `TRUST_PROXY` | `1`. Render vekilinin arkasında bu şart. Boş bırakılırsa hız sınırı ve çerez yanlış IP görür. |
| `ONLINE_LOCK_TRIGGER` | `0`. Üretimde bu anahtar açık kalmamalı. Test saati başlığı production’da kapalıdır. |
| `COOKIE_SECURE` | `always` (blueprint’te durur) |
| `TURSO_DATABASE_URL` | Turso’nun verdiği `libsql://` adresi |
| `TURSO_AUTH_TOKEN` | Yalnızca bu veritabanına bağlı yeni jeton |
| `SESSION_SECRET` | Yeni üretin: `openssl rand -hex 32`. Eski bir parolayı, eski veritabanındaki sırrı veya SMTP parolasını tekrar kullanmayın. |
| `TOTP_ENC_KEY` | 2FA sırrı ve yedek kodları için ayrı anahtar. `openssl rand -hex 32`. En az 32 karakter. `SESSION_SECRET` ile aynı olmasın; oturum sırrını değiştirmek 2FA’yı bozmasın. Üretimde boşsa süreç açılmaz. |
| `ADMIN_EMAIL` | İlk yönetici adresi. Şema açılırken bu adresli hesap bir kez Admin olarak yazılır. Sonraki rütbe değişiklikleri yalnızca rütbe tablosundan gelir. |
| `BREVO_API_KEY` | Brevo transactional API anahtarı. Doluysa bütün postalar HTTPS ile Brevo’ya gider. Değeri repoya, sohbete veya günlüğe yazmayın. |
| `MAIL_FROM_EMAIL` | Brevo’da doğrulanmış gönderen adres. Örnek: `noreply@example.com`. |
| `MAIL_FROM_NAME` | Gönderen adı. Boşsa `Omni`. |
| `SMTP_HOST` | Yalnızca `BREVO_API_KEY` boşsa. Render ücretsiz planda SMTP kullanmayın. |
| `SMTP_PORT` | SMTP kapısı. Ücretsiz planda 25, 465 ve 587 dışarıya kapalıdır. |
| `SMTP_USER` | SMTP kullanıcı adı. Brevo kullanılırken gerekmez. |
| `SMTP_PASS` | SMTP parolası. Eski parolayı yapıştırmayın. Brevo kullanılırken gerekmez. |
| `EMAIL_FROM` | SMTP gönderen adresi. Brevo yolu `MAIL_FROM_EMAIL` kullanır. |
| `STARTING_OMNI_DOLAR` | İsterseniz boş bırakın; kod varsayılanı kullanır. |
| `OMNI_MATCH_WIN_REWARD` | İsterseniz boş bırakın. |
| `MARKET_MIN_PER_GEN` | İsterseniz boş bırakın. |
| `MARKET_MAX_PER_GEN` | İsterseniz boş bırakın. |

`PORT` değerini Render kendisi verir. Elle sabitlemeyin.

Render’ın ücretsiz planı dışarı giden SMTP kapılarını (25, 465 ve 587) engeller. Bu kapılara bağlanan posta gönderimi üretimde zaman aşımına düşer. Üretim postası için Brevo kullanın: ücretsiz planda günde 300 mektup vardır ve istek `https://api.brevo.com/v3/smtp/email` adresine HTTPS (kapı 443) ile gider. Gönderen, Brevo’da doğrulanmış adres olmalıdır (örnek: `noreply@example.com`). `BREVO_API_KEY` doluysa doğrulama kodu, kayıt ve diğer bütün postalar bu ortak gönderim yolundan Brevo’ya gider. Anahtar boşsa mevcut SMTP yolu, yerel geliştirmede olduğu gibi, aynen çalışır.

Eksik üretim ayarı varsa süreç açılışta durur ve günlükte yalnızca eksik **adları** yazar. Adres, jeton, Brevo API anahtarı, SMTP parolası ve oturum sırrı günlüğe yazılmaz.

Üretimde düz HTTP, vekil `x-forwarded-proto: http` gönderdiğinde HTTPS adresine yönlendirilir. HTTPS yanıtlarına HSTS eklenir. `/healthz` bu yönlendirmeden muaftır; Render sağlık kontrolü süreç ayaktayken 200 alır ve veritabanına gitmez.

## 3. GitHub

Bu herkese açık kopya yalnızca kodu göstermek içindir; GitHub Actions iş akışı (sağlık yoklaması, otomatik yedek) içermez ve bu depoya hiçbir sır girilmez. Canlı sistemin yoklaması ve yedekleri WTS STUDIOS'un özel deposunda çalışır.

## 4. Yedek ve geri yükleme

İki yol var. İkisi de ücretsiz planda kart istemez.

**Turso noktası (asıl yol).** Son 24 saat içindeki bir an için yeni veritabanı açın:

```bash
turso db create omni-geri --from-db omni --timestamp 2026-01-01T00:00:00Z
```

Tarihi, dönmek istediğiniz anla değiştirin. Sonra bu yeni veritabanı için yine **yalnızca ona bağlı** bir jeton üretin, Render’daki `TURSO_DATABASE_URL` ve `TURSO_AUTH_TOKEN` değerlerini yenileyin, eski jetonu iptal edin. Eski veritabanını ancak yeni bağlantı çalıştıktan sonra silin.

**Dosya yedeği.** `scripts/` altındaki yedek betiğiyle SQL dökümü alınır ve `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` ile şifrelenir. Otomatik günlük yedek yalnızca özel depoda çalışır. Düz SQL’i repoya, Render diskine veya herkese açık bir yere koymayın.

`BACKUP_PASSPHRASE` yeni bir parola olsun: `openssl rand -hex 32`. Eski parola, SMTP parolası veya `SESSION_SECRET` ile aynı olmasın. Değeri yalnızca özel ortamlarda (özel deponun secret'ları gibi) tutulur. Komut satırına, sohbete veya günlüğe yazmayın. Betikler parolayı `BACKUP_PASSPHRASE` ortam değişkeninden okur; argüman olarak vermeyin.

Dökümde `user_sessions`, `verification_codes`, `pending_registrations`, `verification_sends`, `app_secrets` ve `totp_key` yoktur. Geri yüklemede bu tabloların şeması boş kurulur. Oturumlar, bekleyen doğrulama kodları, uygulama sırrı ve 2FA anahtarı geri gelmez. Üretimdeki `SESSION_SECRET` ve `TOTP_ENC_KEY` ortamda durur.

İndirdiğiniz `.enc` dosyasını yeni bir yerel veritabanına açmak için ortamda parolayı tanımlayıp:

```bash
node scripts/restore-backup.js --in omni.sql.enc --out geri.db
```

Betik hedef dosya varsa durur. Şifreyi çözer, satır sayılarını yedeğin bildirimiyle karşılaştırır, yabancı anahtarları kontrol eder, Omni bakiyesinin eksi olmadığını, yönetici kartı tetikleyicisinin durduğunu ve hariç tabloların boş olduğunu doğrular. Doğrulama tutmazsa hedef dosyayı siler ve sıfırdan farklı bir kodla çıkar.

Yerel bir dosyadan şifresiz döküm almak için (canlı Turso’ya dokunmaz; bu dosya yüklenmez):

```bash
node scripts/export-backup.js --file yerel.db --out yedek.sql
```

Turso’dan döküm, ortamda `TURSO_DATABASE_URL` ve `TURSO_AUTH_TOKEN` varken `--file` olmadan aynı betikle alınır. Betik bu değerleri ekrana yazmaz. GitHub’a giden kopya ancak şifrelendikten sonra yüklenir.

## 5. Açılıştan sonra

1. Render sağlık kontrolü yeşil olunca siteyi tarayıcıda açın. Adres `https://` ile başlamalı.
2. `ADMIN_EMAIL` ile yeni hesap açıp posta kodunu girin. İlk girişte bu hesap Admin olur. Admin ve moderatör, yetkili işlemden önce iki adımlı doğrulamayı kurar. Eski yerel `.db` hesapları gelmez.
3. `ONLINE_LOCK_TRIGGER` değerinin `0` kaldığını bir daha kontrol edin.
4. Jetonu, Brevo API anahtarını ve SMTP parolasını sohbete, günlüğe veya repoya yapıştırmayın.
