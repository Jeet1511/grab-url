# URL Redirect Resolver

[![GitHub](https://img.shields.io/badge/GitHub-grab--url-blue?logo=github)](https://github.com/Jeet1511/grab-url)

A powerful URL unwrapper that uses headless Chromium to follow redirect chains, JavaScript navigation, countdown timers, and meta-refresh redirects to discover the true final destination of any URL.

## 🎯 Purpose

Modern URL shorteners and redirect systems use complex JavaScript, timers, user interactions, and multi-step navigation that simple HTTP clients cannot follow. This resolver opens each URL in a real browser session and intelligently observes the complete navigation lifecycle to find where the URL actually leads.

### What Makes This Different

- **Real Browser Engine**: Uses Chromium via Playwright, not simple HTTP requests
- **Smart Navigation**: Detects and follows JavaScript redirects, countdown gates, and dynamic content
- **Honest Reporting**: Reports authentication walls, CAPTCHAs, and loops instead of fabricating results
- **Security-First**: Built-in SSRF protection, DNS validation, and request filtering

## ✨ Features

- ✅ Follows HTTP 3xx redirects, meta refresh, and JavaScript navigation
- ✅ Detects and waits for countdown timers
- ✅ Handles popups and new tab navigation
- ✅ Identifies external app schemes (telegram://, etc.)
- ✅ Reports blockers honestly (auth, CAPTCHA, payment gates)
- ✅ SSRF protection with DNS validation
- ✅ Rate limiting and concurrency control
- ✅ REST API and Server-Sent Events streaming

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Chromium or Chrome browser
- npm or yarn

### Installation

```bash
npm install
```

### Configuration

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` and set required values:
```env
APP_ID=my-resolver
APP_SECRET=your-secure-secret-key-here
```

### Development

```bash
npm run dev
```

The app will start at `http://localhost:3000`

### Production

```bash
npm run build
npm start
```

## 📡 API Usage

### POST /api/unwrap

Resolve a URL and get the complete result:

```bash
curl -X POST http://localhost:3000/api/unwrap \
  -H "Content-Type: application/json" \
  -d '{"url": "https://bit.ly/example"}'
```

**Response:**
```json
{
  "status": "success",
  "finalUrl": "https://example.com/actual-destination",
  "hops": [
    {
      "url": "https://bit.ly/example",
      "type": "http_redirect",
      "status": 301,
      "timestamp": 1234567890
    }
  ],
  "navigationCount": 3,
  "totalTime": 2453,
  "blocker": null
}
```

### GET /api/unwrap/stream

Get real-time progress updates via Server-Sent Events:

```bash
curl "http://localhost:3000/api/unwrap/stream?url=https://bit.ly/example"
```

**Response (SSE stream):**
```
event: progress
data: {"message": "Starting resolution..."}

event: progress
data: {"message": "Following redirect..."}

event: complete
data: {"status": "success", "finalUrl": "..."}
```

## 🔧 Configuration

All configuration is done via environment variables. See `.env.example` for available options:

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ID` | - | Application identifier (required) |
| `APP_SECRET` | - | Secret key for signing (required) |
| `DATABASE_URL` | - | Database connection (optional, unused by resolver) |
| `URL_UNWRAPPER_CHROMIUM_PATH` | auto | Path to Chromium executable |
| `UNWRAP_TOTAL_TIMEOUT_MS` | 45000 | Maximum time per resolution (ms) |
| `UNWRAP_MAX_NAVIGATIONS` | 20 | Maximum navigation steps |
| `UNWRAP_MAX_POPUPS` | 10 | Maximum popups to follow |
| `MAX_CONCURRENT_JOBS` | 1 | Concurrent browser sessions |

## 🐳 Docker Deployment

The included `Dockerfile` bundles Node.js with system Chromium:

```bash
docker build -t url-resolver .
docker run -p 3000:3000 -e APP_ID=resolver -e APP_SECRET=secret url-resolver
```

### Deploy to Render (Full-Stack)

Deploy both frontend and backend together on Render:

1. Push your code to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New +" → "Web Service"
4. Connect your GitHub repository
5. Render will auto-detect `render.yaml` and configure everything
6. Click "Apply" and "Create Web Service"
7. Wait 5-10 minutes for deployment

The free tier (512MB RAM, 750 hours/month) works perfectly. Your app will be at `https://url-resolver.onrender.com`

### Deploy Split: Vercel (Frontend) + Render (Backend)

For better performance, deploy frontend and backend separately:

**Step 1: Deploy Backend to Render**

1. Follow steps above to deploy to Render
2. Copy your backend URL: `https://YOUR-APP.onrender.com`

**Step 2: Deploy Frontend to Vercel**

1. Edit `vercel.json` and replace `YOUR-BACKEND-URL` with your Render URL
2. Go to [Vercel Dashboard](https://vercel.com/dashboard)
3. Click "Add New..." → "Project"
4. Import your GitHub repository
5. Configure:
   - Framework: Vite
   - Root Directory: `./` (or leave blank)
   - Build Command: `npm run build`
   - Output Directory: `dist/public`
6. Add Environment Variable:
   - Key: `VITE_API_URL`
   - Value: `https://YOUR-APP.onrender.com`
7. Click "Deploy"

Your frontend will be at `https://your-app.vercel.app` and will use Render for API calls.

## 🏗️ Architecture

```
Frontend (React + Vite)
  ↓
Backend API (Hono)
  ↓
Browser Resolver (Playwright + Chromium)
  ↓
Security Layer (SSRF Protection)
  ↓
Destination Validator
```

### Key Components

- **`api/resolver/browser-resolver.ts`**: Core resolution engine
- **`api/resolver/ssrf-protection.ts`**: Security and validation
- **`api/routes/unwrap.ts`**: HTTP endpoints
- **`src/`**: React frontend UI

## 🔒 Security Features

- Protocol and port allowlisting (HTTP/HTTPS only)
- Private IP range blocking (RFC 1918)
- DNS rebinding protection
- Request rate limiting
- Per-client concurrency limits
- User-agent rotation

## 🧪 Testing

```bash
npm run test
```

## 📦 Tech Stack

- **Frontend**: React 19, TailwindCSS, Vite
- **Backend**: Node.js, Hono, tRPC
- **Browser Automation**: Playwright Core
- **Database** (optional): Drizzle ORM, MySQL/SQLite
- **Build**: TypeScript, ESBuild

## 📝 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

## ⚠️ Disclaimer

This tool is for legitimate use cases like security research, SEO analysis, and link validation. Users are responsible for complying with applicable laws and the terms of service of the URLs they resolve.
