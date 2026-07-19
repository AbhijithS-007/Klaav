# Klaav 🎹

Klaav is a modern, unified tab manager that brings all your browser tabs from different browsers (Chrome, Edge, Brave, Vivaldi, Opera, etc.) into a single, elegant native desktop interface. 

Instead of hunting across multiple browser windows for the tab you need, Klaav lives on the edge of your screen and provides a unified chronological timeline of everything you have open.

## Features

- **Cross-Browser Tab Management:** See and switch between tabs across multiple Chromium-based browsers instantly.
- **Chronological Timeline:** Tabs are sorted by when you opened them (oldest first) so your tab history naturally forms a timeline, regardless of which browser it lives in.
- **Carousel UI:** A beautiful vertical carousel interface that scales and fades tabs based on their distance from the center, inspired by native mobile picker wheels.
- **Zero-Friction Access:** The UI stays completely hidden until you move your mouse to the far-left edge of your screen, at which point it instantly appears.
- **Global Hotkey:** Press `Alt + Q` from anywhere to pop open Klaav and "pin" it to your screen. It won't disappear when you move your mouse away until you select a tab or press `Alt + Q` again.
- **Keyboard & Mouse Support:** Scroll through your tabs smoothly using your mouse wheel, or use `ArrowUp` / `ArrowDown` and `Enter` to navigate without lifting your hands from the keyboard.

## How it works

Klaav consists of two parts:
1. **The Desktop App (Rust/Tauri):** A lightweight, borderless desktop window that runs a WebSocket server and polls your OS cursor position to handle native window show/hide seamlessly.
2. **The Browser Extension (Manifest V3):** A lightweight background service worker that tracks tab creation times in `chrome.storage.local` and streams live tab updates (creation, URL changes, activation, and removal) to the desktop app over WebSockets.

## Setup & Installation

### 1. Install the Browser Extension
You need to load the extension into any Chromium browser you want to track.
1. Open your browser and go to the extensions page (e.g., `chrome://extensions` or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder from this repository.

### 2. Run the Desktop App
Ensure you have [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/) installed.

```bash
cd klaav
npm install
npm run tauri dev
```

## Architecture

- **Frontend:** Vanilla JS, HTML, and CSS (with `backdrop-filter` for the glassmorphism effect).
- **Backend:** Rust, using [Tauri](https://tauri.app/) for window management and `tokio-tungstenite` for the WebSocket server.
- **OS Integration:** Uses the `windows` crate to poll `GetCursorPos` natively, ensuring perfectly snappy edge-trigger interactions without GPU compositing bugs.
