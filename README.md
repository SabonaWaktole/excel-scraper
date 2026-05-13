# Excel Community Living Playwright Scraper

Node.js + Playwright automation that:
- logs in with `.env` credentials,
- detects all course links from `/courses/`,
- enrolls if needed,
- attempts to progress lessons automatically,
- extracts media/material URLs from DOM + iframe + network traffic,
- writes grouped results to txt/json/csv.

## Tech Stack
- Playwright (Chromium)
- dotenv
- fs
- csv-writer

## Project Files
- `package.json`
- `.env.example`
- `.gitignore`
- `scrape.js`
- `output/` (generated automatically if missing)

## 1) Install
```bash
npm install
```

## 2) Configure Environment
Create a `.env` file in project root:

```env
EMAIL=your@email.com
PASSWORD=your_password
BASE_URL=https://excelcommunityliving.website
```

You can also copy:

```bash
cp .env.example .env
```

## 3) Run
```bash
npm start
```

Optional slower debug mode:
```bash
npm run debug
```

## Output
Each run **clears the entire `output/` directory** (fresh folders and aggregate files). Set `SKIP_OUTPUT_RESET=1` in the environment if you need to keep existing files.

Generated in `output/`:

- Per course folder (sanitized course name): lesson `.txt` files when content is saved, and **`link.txt`** (one verified video URL per line) when that course has at least one working media URL.

1. `video-links.txt`  
   Grouped exactly by course name, with one URL per line and blank line between courses.

2. `video-links.json`  
   Array format:
   ```json
   [
     { "course": "Course Name", "url": "https://example.com/video.mp4" }
   ]
   ```

3. `video-links.csv`  
   Columns:
   ```csv
   course,url
   ```

## Console Logs
Script logs include lines such as:
- `Logged in successfully`
- `Found 12 courses`
- `Processing course: Course Name`
- `Enrolled successfully`
- `Found video URL: ...`
- `Clicking Next...`
- `Course completed`
- `Saved results`

## Reliability Notes
- Uses retries for click/navigation actions.
- Handles dynamic/lazy content using scrolling + repeated scans.
- Uses both `page.on('request')` and `page.on('response')` to capture hidden media URLs.
- Each course runs in isolation; one failed course does not stop the rest.
- Works in headful mode (`headless: false`) for stability and visibility.
# excel-scraper
