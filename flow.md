# AI Team — Canlı Akış Gözlem Raporu

> Bu dosya, gerçek bir Team run'ı izlerken yapılan **gözlemleri** kaydeder. Bu turda
> hiçbir düzeltme yapılmıyor — yalnızca raporlama. Run bitince değerlendirilecek.

## Run kurulumu
- **Template:** Team 01 (özel) — 5 rol: Lead/Coordinator, Business Analyst, Developer (kod yazar), Tester/QA (kod yazar), Reviewer
- **Proje klasörü:** `C:\Users\serkan\PROJECT\Kaplan`
- **Hedef (goal):** `sistemi en iyi haline getir`
- **runId:** `9R8MPNxB5o_D83ms3N8Ax`
- **Başlangıç:** ~23:50, status RUNNING
- **Backend:** düzeltmeler canlı (round-robin scheduler, tüm roller otonom yazabilir izin: Tester=workspace-write, diğerleri acceptEdits; verification mesaj→kayıt; turn prompt'una "tamamlanmak için ne eksik" enjeksiyonu)

## Beklenen davranış (düzeltmeler sonrası)
- Tüm 5 rol sırayla turn almalı (sadece Lead değil).
- Her rol kendi `.tiger` çıktısını yazabilmeli (izin sorunu olmamalı).
- Roller iş ilerledikçe sign-off vermeli; 5/5 fresh sign-off + verification passed olunca run "completed".

## Gözlem günlüğü
_(zaman damgalı, aşağıya eklenecek)_

### T0 — başlangıç
- Lead/Coordinator: **working** (terminal açıldı), diğer 4 rol: idle.
- Completion gate: 0/5 signed off, pending: lead, business-analyst, developer, tester, reviewer.
- messageCount: 1 (yalnızca kullanıcı steering seed'i: "sistemi en iyi haline getir").

### T1 — 23:53 — Lead turn'ü bitti, ilginç davranışlar
**Lead düzgün delege etti** (7 mesaj): scope `decision` + 4 `handoff` (business-analyst, developer, tester, reviewer'a, sıralı) + bir `signoff` (status: **pending**, henüz done değil).

**🔴 BULGU 1 — Sıra yanlış: Lead'den sonra Business Analyst yerine DİREKT Developer başladı.**
- Beklenen sıra: Lead → Business Analyst → Developer → Tester → Reviewer.
- Gerçekleşen: Lead → **Developer** (BA, Tester, Reviewer hiç başlamadı).
- Kök neden (iki kademeli):
  1. Lead'in `kind:"signoff"` mesajı gövdede *"status is pending rather than done"* diyordu, AMA sistem her signoff-kind mesajı koşulsuz "tamamlanmış sign-off" olarak kaydediyor (status yok sayılıyor). Sonuç: `signed=1/5`, Lead "imzalı" sayıldı.
  2. Round-robin scheduler imzalı rolleri havuzdan çıkarıyor → havuz=[BA, Dev, Tester, Reviewer]. `turnCount(1) % pool.length(4) = 1` → pool[1] = **Developer**. Yani BA (pool[0]) atlandı.
- Yani round-robin "herkes çalışsın"ı kısmen sağlıyor ama (a) sahte sign-off + (b) indeks kayması yüzünden mantıksal sıra bozuluyor.

**🔴 BULGU 2 — Hedef yanlış yorumlandı (.tiger sınırı çatışması).**
- Lead'in scope kararı: *"treat 'sistemi en iyi haline getir' as a request to improve the Tiger system artifacts **inside the strict .tiger workspace**"*.
- Sebep: eklediğim WORKSPACE BOUNDARY kuralı ajanları `.tiger` köküne hapsediyor. Tiger pipeline'da proje `.tiger` ALTINDA yaşar, ama burada team MEVCUT bir projeye (PROJECT\Kaplan) yöneltildi — gerçek kaynak `PROJECT\Kaplan\apps\...`, yani `.tiger`'ın DIŞINDA.
- Sonuç: ajanlar gerçek projeyi göremiyor/değiştiremiyor; hedefi anlamsızca ".tiger metadata'sını iyileştir"e indirgiyor. **Team mevcut projede çalışamıyor.**

**🟡 BULGU 3 — .tiger içeriği team yapısına TAM uygun değil.**
- `ensureScaffold` tüm TIGER PIPELINE ağacını oluşturuyor: `brainstorming/`, `writing-plan/`, `writing-tasks/`, `merged-tasks/`, `executing-plan/`, `task-review/`, `requesting-code-review/`, `system-prompts/` (7 stage promptu), `config.json`, `project-prompt.md`, `run-log.md`.
- Team bunların HİÇBİRİNİ kullanmıyor (team round-robin + conversation ile çalışır). Sadece `.tiger/team/<runId>/` ilgili: `team.json`, `conversation.jsonl`, `.runtime/<turnId>.prompt.md|.output.md|.done`.
- Yani team data'sı temiz organize ama scaffold gereksiz tiger-pipeline klasörleri de döküyor (kafa karıştırıcı, team modeline uygun değil).

### T2 — 23:57 — Developer turn'ü bitti, sıra Tester'a (BA yine atlandı)
**Çalışma sırası şu ana kadar: Lead → Developer → Tester.** Business Analyst HÂLÂ hiç turn almadı.

**🔴 BULGU 1 (doğrulandı, daha kötü):** Round-robin indeksi (`turnCount % pool.length`) havuz boyutu değiştikçe rolleri adil dolaşmıyor ve BA'yı sistematik olarak aç bırakıyor:
- Turn1 turnCount=0 → roles[0]=Lead. Turn2 turnCount=1, havuz(Lead imzalı çıkınca)=[BA,Dev,Test,Rev], 1%4=1→Developer. Turn3 turnCount=2, havuz(Dev imzalı, Lead bayatladı)=[Lead,BA,Test,Rev], 2%4=2→Tester. BA hep pool[0/1]'de kalıp atlanıyor.

**🔴 BULGU 2 (dramatik doğrulama): Team gerçek projeyi DEĞİL, scaffold metadata'sını düzenliyor.**
- Developer'ın yaptığı tek değişiklik: `.tiger/system-prompts/04-merge-tasks.md`'ye bir madde eklemek (bu bir tiger-pipeline prompt şablonu, gerçek Kaplan projesi değil!).
- `git status` (PROJECT\Kaplan) → **BOŞ**. Gerçek proje kaynağına (apps/, src/...) hiçbir dokunuş yok.
- Developer kendi sözleriyle: *"improve .tiger system artifacts... fix the staged pipeline prompts"*. Yani hedef tamamen kaymış; team `.tiger` içindeki çöp scaffold dosyalarını "sistem" sanıyor.
- **Sonuç: bu run hiçbir gerçek iş üretmiyor.** Kök neden BULGU 2'deki .tiger sınır/cwd çatışması.

**🟢 ÇALIŞAN: Verification eşlemesi.** Developer `kind:"verification"` mesajı attı (seq 11) → sistem bunu verification kaydına çevirdi (passed). Done-gate'in "verification passed" şartı artık karşılanabilir.

**🟡 BULGU 4 — Sign-off oscillation (yakınsama riski):** `signed` sürekli ~1/5'te takılı. Her rol bir `decision`/`finding`/`verification` (material) mesajı atınca önceki tüm sign-off'lar bayatlıyor. Lead imzaladı→Developer material attı→Lead bayatladı. Böyle giderse 5/5 fresh sign-off aynı anda asla oluşmayabilir → run tamamlanamaz (maxRounds'a kadar döner).

**🔴 BULGU 5 — Sahte sign-off:** `kind:"signoff"` mesajı koşulsuz "done" sayılıyor; gövdedeki status (pending/blocked/done) ve SignOffDirective yok sayılıyor. Lead "pending" dedi ama imzalı sayıldı (BULGU 1'i tetikledi). Bir rol "henüz hazır değilim" dese bile imzalanmış görünür.

---

## 🎯 İSTENEN SİSTEM TASARIMI (kullanıcı vizyonu — uygulanacak)

Mevcut akış verimsiz ve mantıksız. Hedef: **durmadan, akıllı, context'i koruyan, lead'in yönettiği bir şirket gibi** çalışan sistem.

### 1. Kalıcı CLI oturumları (terminaller kapanmasın, context sıfırlanmasın)
- **Sorun (mevcut):** Her turn için YENİ terminal açılıyor (`team-<runId>-<turnId>`), CLI sıfırdan başlıyor, prompt dosyası okunuyor, iş bitince terminal `stop` ediliyor. Yani **her turn'de o rolün context'i sıfırlanıyor** — claude/codex baştan başlıyor, önceki muhabbeti hatırlamıyor (sadece prompt'a gömülen transcript penceresini görüyor). Açılıp-kapanma + sürekli yeniden başlatma = çok verimsiz, yavaş, pahalı.
- **İstenen:** Her rolün **CLI oturumu canlı kalsın** (terminal açık). Rol tekrar sıra alınca **aynı oturuma yeni prompt gönderilsin** (yeni terminal açma yok). Böylece context korunur, ajan kaldığı yerden devam eder.
- Rol "işini bitirdi mi" anla → bitirince oturumu KAPATMA, açık tut, sırası gelince yeni görevi aynı oturuma yaz.

### 2. Context compaction (şişince /compact)
- Oturum uzayıp **context şiştiğinde** bunu algıla → CLI'a **compact** komutu gönder (claude ve codex İKİSİ DE destekliyor — `/compact` benzeri). Reset etme, compact et.
- Compact'in çalıştığını doğrula/tanı. Compact context'i özetleyip yer açar → oturum canlı kalır, ucuzlar.

### 3. Lead süreci yönetsin (akıllı, dependency-farkında sıralama)
- **Sorun (mevcut):** Kör round-robin (`turnCount % pool`). BA sistematik atlanıyor; sıra mantıksız (Lead→Developer, analiz yapılmadan implement).
- **İstenen:** Lead bir **koordinatör** gibi davransın:
  - İş bağımlılığına göre sırala: analiz bitti → developer'ı çalıştır; developer bitti → tester; vb. (boşta kalan/uygun olanı akıllıca seç).
  - **Lead tasklar tamamlandıkça / işler ilerledikçe YENİ görevler versin** — hedefe doğru. Statik 4 task değil, dinamik akış.
  - Hedef gerçekten karşılanana kadar **durmadan çalışan** bir sistem (boşa dönmeden, mantıklı ilerleyerek).

### 4. UI: döngü/round sayaçları
- Üstte **akış tekrarları** görünsün: "Lead 3 kez çalıştı", round numarası, her rolün turn sayısı vb. Lead'in süreci nasıl yönettiği izlenebilsin.

### 5. Stop vs Close ayrımı (terminal yaşam döngüsü)
- **Yukarıdan STOP** edilince: **prompt akışı dursun** (yeni turn başlamasın) ama **terminaller KILL OLMASIN** — canlı kalsın, kaldığı yerden devam ettirilebilsin.
- **CLOSE** edilince: o zaman terminaller **kill** olsun.
- (Mevcut: Stop hepsini durduruyor/abort ediyor; kalıcı oturum kavramı yok.)

### 6. Özet hedef
Gerçek bir şirket gibi: Lead dağıtır ve yönetir, roller kendi canlı oturumlarında bağımlılık sırasına göre çalışır, context compaction ile verimli kalır, işler bittikçe Lead yeni iş verir, hedef %100 karşılanınca tüm roller imzalar ve sistem durur. Stop = duraklat (oturumlar yaşar), Close = bitir (oturumlar kill).

> NOT: Bunlar bu turda UYGULANMADI. Run gözlemi bitince bu tasarıma göre implement edilecek.

### T3 — 23:59 — Tester bitti, Reviewer çalışıyor — BA hâlâ HİÇ çalışmadı
- Çalışma sırası (4 turn): **Lead → Developer → Tester → Reviewer**. **Business Analyst 4 turn boyunca bir kez bile sıra almadı** (Busi:idle, hiç `*` yok). BA starvation kesin.
- `signed` hep 1/5'te osile ediyor (yalnızca en son imzalayan fresh; diğerleri material mesajlarla bayatlıyor) → BULGU 4 (yakınsama riski) gerçekleşiyor.
- Tahmin: Lead'in havuz indeksi gereği sıradaki turn muhtemelen yine BA değil Lead olacak (turnCount=4 → pool[0]=Lead). BA modulo deseninde sürekli pool[1]'de kalıp atlanıyor.
- Tüm "iş" hâlâ `.tiger/system-prompts/*` üzerinde (scaffold metadata); gerçek proje (PROJECT\Kaplan) `git status` boş.

### 7. Ajan-başına klasör + dosya tabanlı task yaşam döngüsü (Lead-driven task board)
Mevcut "konuşma + kör round-robin" yerine, **gerçek bir task kuyruğu** mekanizması:

**Açılışta:** `.tiger/team/<runId>/agents/<roleId>/` altında her ajan için klasör oluştur. Alt klasörler:
- `todo/` (atanan ama başlanmamış tasklar)
- `in-progress/` (şu an çalışılan)
- `done/` (tamamlanan)
- (opsiyonel `output/` — ajanın o task için ürettiği çıktı)

**Lead task atar:** Lead, bir ajanın `todo/` klasörüne task dosyası bırakır (örn. `TASK-001.md` — açıklama + acceptance criteria).

**Backend sürekli takip eder (watcher):** Proje (orchestrator) her ajanın `todo/` klasörünü izler. Yeni bir task dosyası gelince:
1. Dosyayı **oku**, içeriğini ajanın **canlı oturumuna** prompt olarak ver.
2. Dosyayı `todo/ → in-progress/` taşı (durumu "in-progress" yap).
3. Ajan task'ı bitirince (tamamlanma sinyali) dosyayı `in-progress/ → done/` taşı.

**Kuyruk davranışı:** Bir ajana **birden fazla task** atanırsa → FIFO sırayla, **teker teker**. Ajan birini bitirir, sıradakini alır; biri bitmeden diğerine geçmez ("üzerine beklesin bitince diğerini yapsın").

**Sonuç:** Roller kör sırayla değil, **todo'larında task oldukça** çalışır. Task'ı olmayan ajan bekler (idle). Lead işler ilerledikçe yeni task atar (dinamik). Tüm tasklar `done` + hedef karşılanınca roller imzalar, sistem durur. Bu, BULGU 1'deki (kör round-robin / BA starvation) ve BULGU 4'teki (yakınsama) sorunları kökten çözer + BULGU 2/3'ü (anlamsız .tiger metadata işi) gerçek task akışıyla değiştirir.

> Tüm bu tasarım (1–7) bu turda UYGULANMADI; gözlem bitince mükemmelleştirilecek.
