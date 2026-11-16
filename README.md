# ClarityCart AI | Product Landing Page

![HTML5](https://img.shields.io/badge/html5-%23E34F26.svg?style=for-the-badge&logo=html5&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/tailwindcss-%2338B2AC.svg?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Vercel](https://img.shields.io/badge/vercel-%23000000.svg?style=for-the-badge&logo=vercel&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)

## Overview
ClarityCart AI is a product-page assistant that uses product details to answer questions about an item before purchase. This repository contains the current site, lead form and widget source. The [earlier standalone demo](https://github.com/agouti-ar/clarity-cart-widget) shows the original sneaker example.

[Open the current site](https://claritycart-landing.vercel.app/)

## Demo
![ClarityCart AI Widget Demo](./demo.gif)

## Key Features
- **Zero-dependency Vanilla JS architecture** with Shadow DOM encapsulation.
- **Autonomous context scraping** (JSON-LD & DOM inspection).
- **Responsive marketing page** with a dark theme.
- **Lead capture integration** via Formspree.

## Tech Stack
- HTML5
- Tailwind CSS
- Vanilla JavaScript
- Formspree API
- Vercel

## Local Development
To run this landing page locally, simply follow these steps:

1. Clone the repository:
   ```bash
   git clone https://github.com/agouti-ar/claritycart-landing.git
   cd claritycart-landing
   ```
2. Start a local server:
   - You can use the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension in VS Code.
   - Alternatively, you can use Python or npx:
     ```bash
     npx serve .
     # or
     python3 -m http.server 3000
     ```
3. Open `http://localhost:3000` (or the port provided by your server) in your browser.

## License
This project is licensed under the MIT License.
