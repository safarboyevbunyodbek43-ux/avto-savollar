# Avto maktab ilovasi (MVP)

O'qituvchi va o'quvchilar uchun ilova. U sizning kompyuteringizda (yoki serverda) ishlaydi, ma'lumotlar o'zingizda saqlanadi.

## Nimalar bor

**O'qituvchi oynasi**
- Guruhlar va o'quvchilar. O'quvchi qo'shsangiz, ilova unga login va parol yaratib beradi (parol faqat bir marta ko'rinadi, yo'qolsa "Yangi parol").
- Davomat: kunlik (keldi / kechikdi / kelmadi / sababli) va foiz hisobi.
- Baholar (1 dan 5 gacha): nazariya, amaliyot, imtihon.
- Tahlil: guruh bo'yicha qaysi mavzu chala, har bir o'quvchi qaysi mavzuda zaif (rangli jadval), alohida o'quvchi sahifasi.
- To'lovlar: kurs narxi, kim qancha to'ladi, qarz. **Faqat o'qituvchi ko'radi, o'quvchi ko'rmaydi.**
- Savollar bazasi: JSON fayl yuklash va internetdagi havoladan avtomatik yangilash.

**O'quvchi oynasi** (o'qituvchinikidan butunlay boshqa)
- Bosh sahifa: chala mavzular, davomat, baholar, so'nggi urinishlar.
- Mavzu testi (har mavzudan 10 tagacha savol).
- Real imtihon: 20 savol, 25 daqiqa, ko'pi bilan 2 ta xato (taymer bilan).
- Namuna savollar (to'g'ri javob yashil).

**Tillar:** o'zbekcha (lotin), o'zbekcha (kirill), ruscha, inglizcha. Interfeys ham, savollar ham. Kirill matni lotindan avtomatik hosil bo'ladi.

## MUHIM: savollar haqida

1. Ilovadagi **30 ta savol men yozgan namuna**, rasmiy YHQ bazasi emas. Ularda rasm yo'q va aniq tezlik/masofa raqamlari ataylab kiritilmagan. Haqiqiy tayyorgarlik uchun rasmiy savollar bazasini yuklashingiz kerak.
2. Rasmiy savollar bazasining nusxasi mualliflik huquqi bilan himoyalangan bo'lishi mumkin. Uni yuklashdan oldin foydalanish huquqingiz borligini aniqlang. Men uni internetdan olib bermadim.
3. "Internetdan yangilash" ishlashi uchun **savollar JSON fayli joylashgan havola** kerak (siz yoki hamkoringiz yuritadigan fayl). Ilova o'zi "internetdan savol qidirmaydi", u siz ko'rsatgan havolani kuniga bir marta o'qiydi.
4. Imtihon qoidalari (20 savol, 25 daqiqa, 2 xato) sozlanadi. Ularni rasmiy talabga tekshirib, kerak bo'lsa o'zgartiring (pastda).

## Ishga tushirish (kompyuterda)

### 1-qadam. Node.js o'rnating (bir marta)
1. https://nodejs.org saytiga kiring.
2. **LTS** versiyasini yuklab oling (**22.13 yoki undan yangi** bo'lsin).
3. O'rnatish oynasida hamma joyda "Next" bosing.
4. Tekshirish: Windows'da Start menyuda "cmd" yozib oching, `node -v` yozib Enter bosing. `v22...` ko'rinishi kerak.

### 2-qadam. Ilovani ishga tushiring
1. Bu papkani (`avto-maktab`) kompyuterga chiqaring, masalan `C:\avto-maktab`.
2. Papka ichida manzil satriga `cmd` yozib Enter bosing (qora oyna ochiladi).
3. Quyidagini yozib Enter bosing:
   ```
   node server.js
   ```
4. "Ilova ishga tushdi" degan yozuv chiqadi. Oynani **yopmang**, yopsangiz ilova to'xtaydi.
5. Brauzerda `http://localhost:3000` ni oching.

### 3-qadam. Birinchi kirish
- Login: `ustoz`, parol: `ustoz123`.
- Ilova darhol yangi parol so'raydi. **Albatta o'zgartiring.**
- Keyin: "Guruhlar" bo'limida guruh yarating, o'quvchi qo'shing va ularga login-parol bering.

### 4-qadam. O'quvchilar qanday kiradi
- O'quvchilar bir xil Wi-Fi tarmog'ida bo'lsa: kompyuterning IP manzilini toping (cmd'da `ipconfig`, "IPv4" qatori, masalan `192.168.1.15`). O'quvchi telefonida `http://192.168.1.15:3000` ni ochadi.
- Boshqa joydan (uydan) kirishi uchun ilovani internetdagi serverga qo'yish kerak, quyiga qarang.

## Internetga chiqarish (uydan kirish uchun)

- Oddiy yo'l: oyiga arzon **VPS** (Node.js 22.13+ o'rnatiladigan) olish va papkani u yerga ko'chirish. Uni xizmat sifatida doimiy yoqib qo'yish va domen/HTTPS ulash kerak. Bu texnik ish, mutaxassis yordami tavsiya etiladi.
- **Ogohlantirish:** ko'p BEPUL hostinglarda fayl xotirasi har qayta ishga tushishda o'chadi. Ilova ma'lumotlari `data/` papkadagi fayl ichida, shuning uchun doimiy disk (volume) bo'lmasa, o'quvchilar va baholar yo'qoladi.
- Internetda ishlatsangiz HTTPS shart, aks holda parollar ochiq ketadi.

## Savollarni qo'shish

"Savollar bazasi" bo'limida JSON yuklaysiz. Format:

```json
[
  {
    "topic": "signs",
    "q": { "uz": "Savol matni?", "ru": "Текст вопроса?", "en": "Question text?" },
    "options": {
      "uz": ["Variant A", "Variant B", "Variant C"],
      "ru": ["Вариант A", "Вариант B", "Вариант C"],
      "en": ["Option A", "Option B", "Option C"]
    },
    "correct": 0,
    "image": "https://misol.uz/rasm1.png"
  }
]
```
- `topic`: kichik lotin harf (signs, markings, priority, signals, overtaking, stopping, safety, pedestrians, firstaid, vehicle yoki o'zingiz yangi mavzu nomi). Yangi mavzu nomi ruscha/inglizcha tarjimasiz yozilgan holda ko'rinadi.
- `correct`: to'g'ri javobning tartib raqami, **0 dan** boshlanadi (0 = birinchi variant).
- `q.uz` va `options.uz` shart, `ru`/`en` ixtiyoriy. Kirill nusxa o'zbekcha lotindan avtomatik.
- `image` ixtiyoriy, faqat `https://` havola.
- Bir xil `id` (yoki bir xil matn) qayta yuklansa, savol yangilanadi, ikkilanmaydi.

## Imtihon sozlamalari
Ilovani ishga tushirishdan oldin o'zgartiring (Windows cmd):
```
set EXAM_QUESTIONS=20
set EXAM_MINUTES=25
set EXAM_MAX_ERRORS=2
node server.js
```

## Zaxira nusxa
Hamma ma'lumot `data` papkasida. Uning nusxasini haftada bir flesh-xotiraga oling. Nusxadan tiklash uchun papkani joyiga qaytaring.

## Chala mavzu qanday aniqlanadi
O'quvchi (yoki guruh) bir mavzuda kamida 3 ta javob bergan va to'g'ri javoblar 70% dan past bo'lsa, mavzu "chala" hisoblanadi. Mavzu testlari va imtihonlardagi hamma javoblar hisobga olinadi. Imtihonda javob berilmagan savol xato hisoblanadi.

## Hozircha yo'q narsalar (keyingi versiya)
- Bir nechta o'qituvchi/filial (hozir bitta o'qituvchi hisobi bor).
- O'quvchi parolini o'zi tiklashi (parolni o'qituvchi yangilaydi).
- Savol rasmlarini ilovaning o'ziga yuklash (hozir faqat havola).
- Telefon ilovasi (hozir brauzerda ishlaydi, telefonda ham qulay).
- To'lovni onlayn qabul qilish (hozir o'qituvchi qo'lda yozadi).
