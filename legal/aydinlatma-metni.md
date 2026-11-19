# KVKK Aydınlatma Metni (Omni / Omni.verse)

> **TASLAK — yayından önce avukat onayı gerekir.**
>
> Bu metin, 11 Kasım 2026 itibarıyla `github.com/tensai-61/Turnuva-Yapma-Program` deposunun `main` dalındaki koda ve henüz birleşmemiş oyuncu pazarı çalışmasına (PR #12) dayanır. Köşeli parantezdeki alanlar şirket bilgisiyle doldurulmadan ve avukat incelemesi olmadan yayımlanmamalıdır.

**Son güncelleme:** [TARİH]

## 1. Veri sorumlusu

6698 sayılı Kişisel Verilerin Korunması Kanunu (“**KVKK**”) uyarınca, Omni (Omni.verse) çevrimiçi futbol turnuvası ve lig uygulamasında işlenen kişisel verilerinizin veri sorumlusu:

**[ŞİRKET UNVANI]** (işletme adı: **WTS Studios**)

- Adres: **[ADRES]**
- KEP / e-posta: **[KEP/E-POSTA]**
- İnternet sitesi: **[İNTERNET SİTESİ]**

bu metinde “WTS Studios”, “biz” veya “uygulama” olarak anılır.

## 2. İşlenen kişisel veri kategorileri

Uygulama yalnızca hesap açmanız, hizmeti kullanmanız ve (varsa) havale ile paket siparişi vermeniz için gereken verileri işler. Kimlik belgesi, doğum tarihi, telefon numarası veya açık adres toplanmaz.

| Kategori | Örnek veriler |
| --- | --- |
| Kimlik / hesap | Kullanıcı adı, hesap rolü (oyuncu, yönetici, modder), kayıt tarihi, doğrulama durumu |
| İletişim | E-posta adresi |
| Güvenlik | Parolanın özeti ve tuzu (parolanın kendisi saklanmaz), e-posta doğrulama kodunun özeti, oturum belirtecinin özeti, cihaz kimliği (`deviceId`), ban kayıtları (neden, not, tür, süre, cihaz yasağı) |
| Görsel | İsteğe bağlı profil fotoğrafı (en fazla 512 KB, tarayıcıda üretilen görüntü verisi) |
| Kullanım / oyun | Çevrimdışı turnuva ve takım kayıtlarınız, kadro ve ilk 11 seçimi, lig üyelikleri, fikstür ve maç sonuçları, paket açımları, sanal oyuncu kartları, sanal bakiye ve para defteri (Coin / Ⓞ Dolar; gerçek para değildir) |
| Pazar (PR #12 ile yayımlanması planlanır) | Omni Market ve oyuncu pazarı ilanları ile sanal para satış kayıtları (alıcı / satıcı hesap kimliği, kart, fiyat, tarih) |
| Sipariş | Havale ile paket siparişi verildiğinde sipariş kalemi, tutar, para birimi, referans kodu, durum ve inceleme tarihi. Kullanıcının kendi IBAN’ı alınmaz; gösterilen IBAN şirket / alıcı hesabına aittir |
| Konum (yalnızca tarayıcıda) | Tema önerisi için tarayıcının isteyebileceği anlık konum; bu koordinatlar sunucuya gönderilmez ve veritabanına yazılmaz |
| Teknik (geçici) | İstek IP adresi, hız sınırı ve doğrulama denemeleri — uygulama veritabanına yazılmaz, sunucu belleğinde kısa süre tutulur. Barındırma açıldığında erişim günlüklerinde IP görünebilir |
| Çerez ve yerel depolama | Aşağıdaki [Çerez Politikası](./cerez-politikasi.md) tablosundaki anahtarlar |

## 3. İşleme amaçları

Kişisel verileriniz şu amaçlarla işlenir:

- Hesap oluşturmak, e-posta ile doğrulamak, oturum açmak ve kapatmak
- Online lig, maç simülasyonu, paket mağazası, sanal ekonomi ve (yayımlanırsa) pazar hizmetlerini sunmak
- Profilinizi (kullanıcı adı, isteğe bağlı fotoğraf) ve tercihlerinizi (dil, tema) yönetmek
- Çevrimdışı turnuva / takım verilerinizi hesabınıza kaydetmek
- Güvenliği sağlamak: parola doğrulama, hız sınırı, cihaz yasağı, geçici veya kalıcı ban, yönetici şifre yeniden doğrulaması
- Havale siparişi oluşursa siparişi kaydetmek, referans kodu üretmek ve ödemeyi onaylamak veya reddetmek
- Kullanıcılar arası oyunda kullanıcı adını, fotoğrafı, lig üyeliğini ve maç sonuçlarını diğer oyunculara göstermek
- Yasal yükümlülükleri yerine getirmek ve hak taleplerini karşılamak
- KVKK m.11 kapsamındaki başvurularınızı cevaplamak

Pazarlama iletisi veya profilleme reklamı bugün gönderilmez. Bu amaç sonradan eklenirse ayrıca açık rıza alınır.

**Hiper paketi** (gerçek para birimi ile satılması planlanan paket) kodda satışa kapalıdır. Gerçek para ile satış başlarsa bu metin güncellenir; fiyat bu taslakta yer almaz.

## 4. Hukuki sebepler (KVKK m.5)

| Hukuki sebep | Örnek işlemler |
| --- | --- |
| **m.5/2-c** — Bir sözleşmenin kurulması veya ifası | Kayıt, giriş, lig, maç, paket, sanal bakiye, hesap verilerinin saklanması |
| **m.5/2-ç** — Hukuki yükümlülük | Tutulması gereken ticari / mali kayıtlar (havale siparişleri devreye girerse), resmi başvurular |
| **m.5/2-e** — Bir hakkın tesisi, kullanılması veya korunması | Ban ve itiraz kayıtları, değiştirilemeyen maç ve defter kayıtları, uyuşmazlık |
| **m.5/2-f** — Meşru menfaat (temel hak ve özgürlüklerinize zarar vermemek kaydıyla) | IP üzerinden hız sınırı, oturum güvenliği, kötüye kullanımı önleme, günlükler |
| **m.5/1** — Açık rıza | Zorunlu olmayan çerez / yerel depolama, konum ile tema önerisi, ileride eklenebilecek analitik, robot doğrulama (captcha) veya pazarlama |

Parola özeti, oturum ve doğrulama kodu özetleri güvenlik amacıyla; profil fotoğrafı verdiğiniz ölçüde sözleşme ifası ve sizin fiili davranışınızla işlenir.

## 5. Toplama yöntemi

Veriler doğrudan sizden, elektronik ortamda toplanır:

- Kayıt, doğrulama, giriş ve profil formları
- Uygulama içi işlemleriniz (lig, maç, paket, sipariş, pazar)
- Tarayıcınıza yazılan çerez ve `localStorage` anahtarları
- Tarayıcınızın (izin verirseniz) konum API’si — yalnızca cihazınızda tema seçmek için
- Sunucunun gördüğü IP ve istek başlıkları (hız sınırı ve güvenli çerez ayarı)

Üçüncü kişilerden kredi skorı, reklam profili veya dış liste alınmaz.

## 6. Aktarım ve yurt dışı aktarım (KVKK m.9)

Verileriniz, yukarıdaki amaçlarla sınırlı olmak üzere şu alıcılara aktarılabilir:

| Alıcı | Rol | Durum (kod, 11 Kasım 2026) |
| --- | --- | --- |
| WTS Studios yetkili yöneticileri / görevlileri | Hesap, ban, sipariş ve güvenlik yönetimi | Mevcut (yönetici e-postası ortam değişkeniyle tanımlanır) |
| E-posta altyapısı (SMTP; ileride Resend planlanır) | Doğrulama kodu gönderimi | Mevcut: Nodemailer + `SMTP_*` / `EMAIL_FROM`. Resend henüz kodda yoktur |
| Turso (bulut veritabanı, AWS Frankfurt planlanır) | Hesap ve oyun verilerinin barındırılması | Planlanır; `main` dalında veritabanı yerel SQLite dosyasıdır (`node:sqlite`) |
| Render | Uygulama sunucusunun barındırılması | Planlanır; bölge yayından önce netleştirilecektir (ABD veya başka bir bölge olabilir) |
| Robot doğrulama (captcha) sağlayıcısı | Kayıt / girişte bot engeli | Planlanır; henüz kodda yoktur |
| Yetkili kamu kurumları | Kanunen zorunlu haller | İhtiyaç olursa |

**Yurt dışı aktarım:** Turso’nun Frankfurt bölgesi Avrupa’dadır. Render, SMTP / Resend veya captcha sağlayıcısının sunucuları Avrupa Ekonomik Alanı veya Türkiye dışında (örneğin ABD) olabilir. Bu aktarımlar KVKK m.9’a uygun olarak, yeterli korumanın bulunduğu ülke, Kurul’un uygun bulduğu güvence (standart sözleşme maddeleri vb.) veya kanunda sayılan diğer hallerden biri tamamlanmadan canlıya alınmamalıdır. Sağlayıcı sözleşme ve KVKK uyum metinleri ([işleme envanterindeki boşluklar](./veri-envanteri.md)) yayından önce doldurulacaktır.

Diğer oyuncular yalnızca herkese açık oyun bilgilerinizi görür: kullanıcı adı, profil fotoğrafı, lig üyeliği, fikstür ve maç sonucu. E-posta adresi diğer oyunculara gösterilmez.

## 7. Saklama

Ayrıntılı süreler [Gizlilik Politikası](./gizlilik-politikasi.md) içindedir. Özetle: doğrulanmamış kayıt ve bekleyen kayıtlar 24 saat sonra silinir; doğrulama kodu 10 dakika geçerlidir; oturum 30 gündür; doğrulanmış hesap ve oyun kayıtları hesabınız durduğu sürece (ve yasal saklama gereken sipariş / defter kayıtları ilgili süre boyunca) tutulur.

## 8. KVKK m.11 kapsamındaki haklarınız

Kanun’un 11. maddesi uyarınca veri sorumlusuna başvurarak:

- Kişisel verilerinizin işlenip işlenmediğini öğrenme
- İşlenmişse buna ilişkin bilgi talep etme
- İşleme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme
- Yurt içinde veya yurt dışında aktarıldığı üçüncü kişileri bilme
- Eksik veya yanlış işlenmişse düzeltilmesini isteme
- m.7’deki şartlar çerçevesinde silinmesini veya yok edilmesini isteme
- Düzeltme / silme işlemlerinin, verilerin aktarıldığı üçüncü kişilere bildirilmesini isteme
- İşlenen verilerin münhasıran otomatik sistemler ile analiz edilmesi suretiyle aleyhinize bir sonucun ortaya çıkmasına itiraz etme
- Kanuna aykırı işleme nedeniyle zarara uğramanız hâlinde zararın giderilmesini talep etme

haklarına sahipsiniz.

**Kod notu (yayından önce giderilmelidir):** Bugün uygulamada doğrulanmış hesap için otomatik “hesabımı sil” veya “verilerimi indir” uç noktası yoktur. Bu talepler aşağıdaki başvuru yoluyla elle karşılanır; silme ve dışa aktarma işlevi koda eklenene kadar başvurular [KEP/E-POSTA] üzerinden işlenir.

## 9. Başvuru yolu

Başvurularınızı, 30.03.2016 tarihli ve 29677 sayılı Resmî Gazete’de yayımlanan *Veri Sorumlusuna Başvuru Usul ve Esasları Hakkında Tebliğ*’e uygun olarak:

- KEP veya e-posta: **[KEP/E-POSTA]**
- Yazılı: **[ADRES]**

adresine iletebilirsiniz. Başvuruda ad-soyad, T.C. kimlik numarası (veya yabancılar için uyruğunuz ve pasaport / kimlik numarası), tebligata esas yerleşim yeri veya iş yeri adresi, varsa KEP / e-posta, talep konusu ve kimliği tevsik edici belgeler bulunmalıdır.

Başvurular kural olarak 30 gün içinde ücretsiz sonuçlandırılır. İşlemin ayrıca bir maliyet gerektirdiği hâllerde Kurulca belirlenen tarifedeki ücret istenebilir.

Cevabı yeterli bulmazsanız, cevabı öğrendiğiniz tarihten itibaren 30 gün ve her hâlde başvuru tarihinden itibaren 60 gün içinde **Kişisel Verileri Koruma Kurulu**’na şikâyette bulunabilirsiniz.

Bu metnin güncel sürümü uygulama içinde ve **[İNTERNET SİTESİ]** adresinde yayımlanır. Çerezler için ayrıca [Çerez Politikası](./cerez-politikasi.md), saklama ve güvenlik ayrıntıları için [Gizlilik Politikası](./gizlilik-politikasi.md) geçerlidir.
