
# 🎙️ Smart Push-to-Talk (PTT) Web Application with GenAI Intelligence

A real-time, browser-based Push-to-Talk (PTT) web application for large classrooms, enabling students to verbally engage with instructors using their own devices. The app ensures only one student speaks at a time (First-Come-First-Serve) via WebSockets. Now enhanced with **Generative AI** features such as **Speech-to-Text**, **Language Polishing**, **Live Summarization**, and an **AI Teaching Assistant**.

---

## 🚀 Live Demo

- 🌐 Client: [ptt.projects.richarddominick.me](http://ptt.projects.richarddominick.me)
- ⚙️ API Server: [api.ptt.projects.richarddominick.me](http://api.ptt.projects.richarddominick.me)

---

## 📦 Project Structure

| Folder           | Description                          |
|------------------|--------------------------------------|
| `apps/client`    | React + TypeScript frontend          |
| `apps/server`    | Node.js + Hono backend               |
| `docs/`          | Feature roadmap and GenAI design     |

---

## 🛠 Features

### ✅ Core PTT Features
- Role-based entry: Student or Instructor
- Join/Create room using 6-digit code
- FCFS queue: only one speaker at a time
- Audio streaming over WebSocket
- Session time limit (1 hour)
- Instructor mute/unmute toggle
- Anonymous avatars + random names
- Session recording & downloadable audio archive

### 🤖 GenAI Integration (In Progress)
- Whisper-based real-time **Speech-to-Text**
- Profanity detection and filtering
- GPT-powered **language polishing**
- Real-time **question summarization**
- Topic tagging and sentiment analysis
- AI Teaching Assistant (voice/text reply)

👉 See [`docs/FEATURES.md`](docs/FEATURES.md) for GenAI feature roadmap.

---

## 🧠 Architecture Overview

- **Client**: Web app (React + MediaRecorder) for audio capture
- **Server**: Node.js + WebSocket for real-time streaming and FCFS handling
- **Rooms**: Support for multiple PTT sessions concurrently
- **Audio Queue**: FCFS queue ensures orderly mic access

```
[Student Mic] ──▶ [PTT Server (WebSocket)] ──▶ [Instructor Audio]
                      │
                      ▼
               [Whisper STT]
                      ▼
                [LLM Analysis]
                      ▼
          [Dashboard / AI Feedback]
```

---

## 🧪 How to Run Locally

### 1. Clone and Install
```bash
git clone https://github.com/RichDom2185/cs3103-project.git
cd cs3103-project
yarn install
```

### 2. Environment Setup
- Copy and configure env files:
  - `apps/client/.env.local` ← based on `.env.local.example`
  - `apps/server/.env` ← based on `.env.example`

### 3. Development Mode
```bash
yarn dev
```

### 4. Production Build
```bash
yarn build
```

> ⚠️ To test mic input locally over HTTP, use `--unsafely-treat-insecure-origin-as-secure` in Chrome, or use HTTPS.

---

## 📄 Documentation

- [`docs/FEATURES.md`](docs/FEATURES.md): Full GenAI feature roadmap and prompt examples
- `CS3103_Project_Report.pdf`: Technical write-up and assignment submission

---

## 🙏 Acknowledgements

- [OpenAI Whisper](https://github.com/openai/whisper)
- [OpenAI GPT API](https://platform.openai.com/)
- [bad-words profanity filter](https://www.npmjs.com/package/bad-words)
- [Hono Web Framework](https://hono.dev/)

---

## 📜 License

MIT License. See `LICENSE`.
