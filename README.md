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

### 3. בנייה להפצה (Google Play / App Store)
```bash
cd mobile
npx eas-cli@latest build --platform android --profile preview   # APK להתקנה ישירה
npx eas-cli@latest build --platform all --profile production    # AAB + IPA לחנויות
```
לפני הפצה: לפרוס את `server/` לשרת עם HTTPS (Render / Fly.io / Railway / Cloud Run), להגדיר `APP_KEY` בשרת ו-`EXPO_PUBLIC_APP_KEY` באפליקציה, ולעדכן את `bundleIdentifier` / `package` ב-`mobile/app.json`.

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
