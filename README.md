# Polyglot Voice – מתרגם דיבור לדיבור (Android / iOS)

אפליקציה שמתרגמת **דיבור ← תמלול ← תרגום ← דיבור** בין **116 שפות** (100 השפות המדוברות בעולם + עברית ושפות לאומיות נוספות).

| שלב | איך |
|---|---|
| 🎤 הקלטה | `expo-audio` במכשיר |
| 📝 תמלול **בזמן אמת** | שמע PCM נשלח מהמיקרופון (`useAudioStream`) דרך WebSocket לשרת ← OpenAI Realtime (`gpt-4o-transcribe`). הטקסט מופיע על המסך תוך כדי דיבור |
| 🌐 תרגום | Claude (`claude-opus-5-5`, effort נמוך לזמן תגובה מהיר) עם פלט JSON מובנה + זיהוי שפת המקור |
| 🔊 הקראה (TTS) | קול מובנה של המכשיר (`expo-speech`, חינם ואופליין) ואם אין קול לשפה – TTS מהשרת (`gpt-4o-mini-tts`) |

## מבנה

```
mobile/   אפליקציית Expo (React Native + TypeScript) – Android, iOS (וגם web)
server/   שרת Node/Express שמחזיק את מפתחות ה-API (לעולם לא בתוך האפליקציה)
```

### מסך האפליקציה
- שני כפתורי שפה (צד A / צד B) עם החלפה ⇄ וחיפוש בכל 116 השפות (בשם באנגלית או בשם המקורי).
- **מצב שיחה**: מיקרופון לכל צד – כל אחד מדבר בשפה שלו ושומע את התרגום בשפה של השני.
- **תמלול חי**: בזמן הדיבור מופיע כרטיס שבו הטקסט נבנה מילה אחר מילה. כל משפט שהסתיים (הפסקה קצרה) ננעל כסופי.
- **תרגום חי**: כל משפט שננעל מתורגם מיד (המשפטים הקודמים נשלחים כהקשר), והתרגום מופיע מתחת לתמלול בזמן שממשיכים לדבר.
- **הקראה חיה** (מתג "Speak each sentence while talking"): כל משפט מתורגם מוקרא מיד, בתור ובסדר הנכון. בזמן ההקראה המיקרופון מושתק כדי שהאפליקציה לא תתמלל את הקול של עצמה. עם אוזניות זה נוח במיוחד.
- **מצב פנים-מול-פנים** (👥): הטלפון מונח על השולחן בין שני אנשים. המסך מפוצל לשניים: החצי העליון הפוך לבן השיח שמולך, ולכל צד מיקרופון ושפה משלו. כל צד רואה בגדול, בשפה שלו, את מה שהצד השני אמר, כולל תרגום חי תוך כדי דיבור. בחירת השפה לצד העליון נפתחת הפוכה, והמסך לא נכבה במצב הזה.
- **זיהוי אוזניות** (🎧): מודול נייטיב מקומי (`mobile/modules/audio-route`, Swift + Kotlin) מזהה אוזניות חוטיות, Bluetooth ו-USB, ומתעדכן בזמן חיבור וניתוק. עם אוזניות המיקרופון נשאר פתוח בזמן הקראה חיה, כי אין הד. ברמקול הוא מושתק. ב-Expo Go ובדפדפן, שבהם המודול לא קיים, מופיע מתג ידני "I'm wearing headphones".
- גיבוי: במקביל נשמר קובץ WAV. אם החיבור החי נופל, הקובץ נשלח לתמלול רגיל ושום דבר לא הולך לאיבוד.
- כל הודעה מציגה את **התמלול המקורי** ואת **התרגום**, עם כפתור 🔊 להשמעה חוזרת. תמיכה ב-RTL (עברית, ערבית, פרסית, אורדו...).
- זיהוי שפה אוטומטי, הקלדת טקסט במקום דיבור, היסטוריה נשמרת במכשיר.
- שפות שמסומנות `speech beta` – מודל התמלול לא תומך בהן רשמית, ולכן דיוק התמלול נמוך יותר (התרגום וההקראה עובדים כרגיל).

## הרצה

### 1. שרת
```bash
cd server
cp .env.example .env      # ANTHROPIC_API_KEY, OPENAI_API_KEY
npm install
npm run dev               # http://0.0.0.0:8787
```

### 2. אפליקציה
```bash
cd mobile
cp .env.example .env      # EXPO_PUBLIC_API_URL=http://<LAN-IP-של-המחשב>:8787
npm install
npx expo start            # סרקו את ה-QR עם Expo Go (Android / iOS)
```

> זיהוי האוזניות האוטומטי דורש גרסת פיתוח, כי Expo Go לא כולל מודולים נייטיב מותאמים: `npx expo run:android` / `npx expo run:ios`, או `npx eas-cli@latest build --profile development`.

### 3. בנייה להפצה (Google Play / App Store)
```bash
cd mobile
npx eas-cli@latest build --platform android --profile preview   # APK להתקנה ישירה
npx eas-cli@latest build --platform all --profile production    # AAB + IPA לחנויות
```
לפני הפצה: לפרוס את `server/` לשרת עם HTTPS (Render / Fly.io / Railway / Cloud Run), להגדיר `APP_KEY` בשרת ו-`EXPO_PUBLIC_APP_KEY` באפליקציה, ולעדכן את `bundleIdentifier` / `package` ב-`mobile/app.json`.

## העלאת השרת ל-Render

הקובץ `render.yaml` בשורש הריפו מגדיר את השרת כ-Web Service (Node 22, אזור פרנקפורט, בדיקת תקינות ב-`/health`). WebSocket של התמלול החי עובד ב-Render בלי הגדרה נוספת.

1. ב-[dashboard.render.com](https://dashboard.render.com): **New ← Blueprint**, מחברים את GitHub ובוחרים את `moocky/test-repo`. בוחרים את הענף שבו נמצא הקוד (או ממזגים קודם ל-`main`).
2. Render יבקש את הערכים הסודיים: מדביקים את `ANTHROPIC_API_KEY` ואת `OPENAI_API_KEY`. את `APP_KEY` הוא מייצר לבד.
3. **Apply**. הבנייה לוקחת כ-2–3 דקות. בסוף מקבלים כתובת כמו `https://polyglot-voice-api.onrender.com`.
4. בדיקה: פותחים בדפדפן `https://<הכתובת>/health`, והתשובה צריכה להיות `{"ok":true}`.
5. מעתיקים את הערך של `APP_KEY` (Service ← Environment).

### חיבור האפליקציה לשרת
- **פיתוח מקומי:** ב-`mobile/.env`:
  ```
  EXPO_PUBLIC_API_URL=https://polyglot-voice-api.onrender.com
  EXPO_PUBLIC_APP_KEY=<הערך של APP_KEY>
  ```
- **בניות EAS:** הכתובת כבר מוגדרת ב-`mobile/eas.json` (בפרופילים preview ו-production). אם Render נתן כתובת אחרת, מעדכנים אותה שם. את המפתח מגדירים כמשתנה של EAS ולא בקוד:
  ```bash
  cd mobile
  npx eas-cli@latest env:create --name EXPO_PUBLIC_APP_KEY --value <APP_KEY> --environment preview --environment production --visibility sensitive
  ```

### כדאי לדעת
- **התוכנית החינמית נרדמת** אחרי 15 דקות בלי שימוש, והבקשה הראשונה אחרי זה לוקחת כדקה. לשימוש אמיתי כדאי לשנות ב-`render.yaml` ל-`plan: starter` (כ-7$ לחודש), שלא נרדם.
- **`APP_KEY` הוא הגנה בסיסית בלבד.** מי שמפרק את האפליקציה יכול לחלץ אותו. הגבלת הקצב (ראה למטה) מגבילה את הנזק גם במקרה כזה. לאפליקציה ציבורית בהיקף גדול כדאי להוסיף גם התחברות משתמשים.
- כל push לענף המחובר מפעיל בנייה ופריסה מחדש אוטומטית.

## הגבלת קצב

השרת סופר כל בקשה שעולה כסף (תמלול, תרגום, הקראה, סשן חי) פעמיים: לפי **מזהה מכשיר** אקראי שהאפליקציה יוצרת ושולחת, ולפי **כתובת IP**. הגבולות לפי IP רחבים יותר, כי הרבה טלפונים ברשת סלולרית יכולים לחלוק כתובת אחת. מי שמחליף מזהה מכשיר עדיין נתקל בגבול ה-IP.

| הגדרה | ברירת מחדל | משמעות |
|---|---|---|
| `RATE_LIMIT_DEVICE_PER_MINUTE` | 40 | בקשות לדקה למכשיר. תרגום חי שולח בקשה לכל משפט |
| `RATE_LIMIT_IP_PER_MINUTE` | 120 | בקשות לדקה לכתובת IP |
| `RATE_LIMIT_DEVICE_PER_DAY` | 600 | בקשות ליממה למכשיר |
| `RATE_LIMIT_IP_PER_DAY` | 3000 | בקשות ליממה לכתובת IP |
| `LIVE_MAX_CONCURRENT_PER_DEVICE` / `_PER_IP` / `_TOTAL` | 1 / 6 / 50 | סשנים חיים במקביל |
| `LIVE_MAX_SECONDS` | 180 | אורך מקסימלי לסשן חי. בסופו האפליקציה עוצרת ומתרגמת אוטומטית |
| `MAX_TEXT_CHARS` | 2000 | אורך מקסימלי לטקסט לתרגום או להקראה |
| `TRUST_PROXY` | 1 | מספר הפרוקסים שלפני השרת (ב-Render: 1). כשהשרת חשוף ישירות לאינטרנט: 0 |

מעבר לגבול השרת מחזיר `429` עם `Retry-After`, והאפליקציה מציגה הודעה בהתאם. הקלטה מוגבלת ל-10MB, וטקסט ל-64KB לבקשה.
המונים נשמרים בזיכרון, וזה מתאים לשרת יחיד. אם מריצים כמה מופעים, צריך להעביר אותם ל-Redis.

## API של השרת
| Endpoint | קלט | פלט |
|---|---|---|
| `POST /api/speech-translate` | multipart: `audio`, `sourceStt`, `sourceName`, `targetName`, `serverTts` | `{ transcript, translation, detectedLanguage, audioBase64? }` |
| `POST /api/translate` | `{ text, sourceName?, targetName, context?: string[] }` | `{ translation, detectedLanguage }` |
| `POST /api/tts` | `{ text, languageName }` | `{ audioBase64 }` (MP3) |
| `GET /health` | – | `{ ok: true }` |
| `WS /ws/transcribe?lang=&key=` | פריימים בינאריים PCM16 מונו 24kHz, ואז `{"type":"stop"}` | `ready` / `partial` / `final` / `done` / `error` |

## עלויות (בערך, לכל משפט קצר)
תמלול ~0.6¢ לדקה, תרגום Claude כמה עשיריות סנט, TTS מהשרת רק כשאין קול במכשיר.

## מגבלות ידועות
- תרגום משפט-משפט מקבל הקשר של 3 המשפטים הקודמים בלבד. משפט ארוך מאוד בלי הפסקות יתורגם רק כשתהיה הפסקה או כשלוחצים "עצור".
- בהקראה חיה דרך הרמקול, דיבור שנאמר בזמן שהטלפון מקריא לא נקלט (השתקה למניעת הד).
- אם השרת מאחורי פרוקסי, הוא צריך לתמוך ב-WebSocket.
- קולות ההקראה במכשיר תלויים במערכת ההפעלה; ניתן להוריד קולות נוספים בהגדרות ה-TTS של Android / iOS.
