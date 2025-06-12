
# 🤖 GenAI Feature Roadmap for Smart Push-to-Talk (PTT)

This document outlines the planned and in-progress GenAI enhancements under:

- **Epic 2: GenAI Integration**
- **Epic 3: Interactive AI Features**

---

## 🧠 Epic 2: GenAI Integration

### ✅ 2.1 Real-Time Speech-to-Text (STT)
- [ ] Integrate Whisper for transcribing student speech in real time
- [ ] Display raw transcription to instructor

### ✅ 2.2 Profanity Detection
- [ ] Apply blocklist and regex-based profanity filter
- [ ] Optionally replace or mask words in transcript

### ✅ 2.3 Language Polishing (LLM)
- [ ] Send raw STT output to GPT for grammar correction
- [ ] Rephrase questions into polite, academic form
- [ ] Display side-by-side polished and original text

### ✅ 2.4 Question Summarization
- [ ] Summarize long/rambling student queries using GPT
- [ ] Highlight the core question or confusion area

### ✅ 2.5 Topic Tagging & Categorization
- [ ] Classify questions by topic (e.g., Networking, Transport Layer)
- [ ] Add visual tags in the instructor UI

---

## 🧑‍🏫 Epic 3: Interactive AI Features

### ✅ 3.1 AI Lecturer Assistant (Ask AI Mode)
- [ ] Let leturers see the possible answers/pointers for the stdeunt questions live in Text mode(As soon as the stdeunt complete asking the question) 

### ✅ 3.2 Sentiment and Tone Detection
- [ ] Detect negative tone or confusion (e.g., "I don't get this")
- [ ] Alert instructor with emotional indicators

### ✅ 3.3 Classroom Feedback Summary
- [ ] End-of-session summary: who spoke, what topics
- [ ] Auto-generated discussion transcript with AI tags

### ✅ 3.4 Offline TA Mode (AI Teaching Assistant) (for Self-study)
- [ ] Enable students to ask verbal questions outside class hours
- [ ] LLM answers are saved to student Q&A history
- [ ] Local or cloud TTS can read answers aloud

---

## 🧰 Tooling Plan

| Function          | Tool                         |
|------------------|------------------------------|
| STT              | OpenAI Whisper / Vosk        |
| Profanity Filter | `bad-words`, regex           |
| LLM              | GPT-3.5-turbo, Mistral       |
| TTS (optional)   | pyttsx3, ElevenLabs, gTTS     |

---

## 💬 Prompt Engineering Examples

**Polishing Prompt**:
```text
Rephrase the following student question into a polite and academic form:
"Why the hell are we using UDP instead of TCP?"
```

**Summarization Prompt**:
```text
Summarize the key question from this input:
"I'm confused... so like... is TCP better or not? I don’t get it when it comes to video streaming."
```

**Teaching Assistant Prompt**:
```text
Explain this question in simple terms with an example:
"Why is UDP used in VoIP instead of TCP?"
```

---

## 📌 Status Tracking

| Feature                       | Status     |
|------------------------------|------------|
| Whisper STT                  | 🔄 In Progress |
| GPT-based Polishing          | ⏳ Planned |
| Summarization & Tagging      | ⏳ Planned |
| AI TA Mode                   | ⏳ Planned |
| Sentiment Detection          | ⏳ Planned |
| End-of-Class Summary         | ⏳ Planned |

---

This roadmap will be updated as features are built and deployed. Contributions and feedback welcome!
