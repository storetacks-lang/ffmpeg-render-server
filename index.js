const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp/renders';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const jobs = {};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function ensureH264(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`, (err, stdout) => {
      if (err) return reject(err);
      const codec = stdout.trim().toLowerCase();
      if (codec === 'hevc' || codec === 'h265') {
        runFFmpeg(`ffmpeg -y -i "${inputPath}" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`)
          .then(resolve).catch(reject);
      } else {
        fs.copyFileSync(inputPath, outputPath);
        resolve();
      }
    });
  });
}

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.get('/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'done' && job.filePath) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="render_${req.params.jobId}.mp4"`);
    const stream = fs.createReadStream(job.filePath);
    stream.pipe(res);
    stream.on('end', () => {
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch(e) {}
      delete jobs[req.params.jobId];
    });
  } else {
    res.json({ status: job.status, progress: job.progress, url: job.url || null, message: job.message });
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress, url: job.url || null, message: job.message });
});

app.post('/render', async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'running', progress: 0, url: null, message: 'Starting...' };
  res.json({ jobId });

  // Support both payload formats
  let videoClips = req.body.videoClips;
  let output = req.body.output;

  if (!videoClips && req.body.movie) {
    const movie = req.body.movie;
    output = {
      resolution: movie.resolution || '1080p',
      fps: movie.fps || 30,
      quality: movie.quality || 'max'
    };
    videoClips = [];
    for (const scene of (movie.scenes || [])) {
      const videoEl = scene.elements?.find(e => e.type === 'video');
      const overlayEls = scene.elements?.filter(e => e.type !== 'video') || [];
      if (videoEl) {
        videoClips.push({
          src: videoEl.src,
          start: videoEl.start || 0,
          duration: videoEl.duration || scene.duration,
          audioMuted: videoEl.audioMuted || false,
          overlays: overlayEls.map(el => ({ ...el, settings: el.settings || el }))
        });
      }
    }
  }

  const dir = path.join(TMP, jobId);
  fs.mkdirSync(dir);

  try {
    const fps = output?.fps || 30;
    const resolution = output?.resolution === '1080p' ? '1920x1080' : '1280x720';
    const [outW, outH] = resolution.split('x').map(Number);
    const PREVIEW_W = 540;
    const PREVIEW_H = 960;
    const scaleX = outW / PREVIEW_W;
    const scaleY = outH / PREVIEW_H;

    jobs[jobId].message = 'Downloading clips...';
    jobs[jobId].progress = 10;

    const segmentPaths = [];

    for (let i = 0; i < (videoClips || []).length; i++) {
      const clip = videoClips[i];

      // Download + convert
      const raw = path.join(dir, `clip${i}_raw`);
      await download(clip.src, raw);
      const converted = path.join(dir, `clip${i}_h264.mp4`);
      await ensureH264(raw, converted);

      // Trim
      const start = clip.start || 0;
      const durArg = clip.duration ? `-t ${clip.duration}` : '';
      const audioArg = clip.audioMuted ? '-an' : '-c:a copy';
      const trimmed = path.join(dir, `clip${i}_trim.mp4`);
      await runFFmpeg(`ffmpeg -y -ss ${start} -i "${converted}" ${durArg} -c:v copy ${audioArg} "${trimmed}"`);

      const overlays = clip.overlays || [];
      const imageOverlays = overlays.filter(o => o.type === 'image');
      const audioOverlays = overlays.filter(o => o.type === 'audio');
      const segOut = path.join(dir, `seg${i}.mp4`);

      if (imageOverlays.length === 0 && audioOverlays.length === 0) {
        fs.copyFileSync(trimmed, segOut);
      } else if (imageOverlays.length > 0 && audioOverlays.length === 0) {
        // Overlay PNG images at exact pixel positions with timing
        let filterComplex = '';
        let inputs = `-i "${trimmed}"`;
        let lastLabel = '[0:v]';

        for (let j = 0; j < imageOverlays.length; j++) {
          const img = imageOverlays[j];
          const s = img.settings || img;
          const imgPath = path.join(dir, `clip${i}_img${j}.png`);
          await download(img.src || s.src, imgPath);

          // Scale image to render resolution coordinates
          const x = Math.round((s.x != null ? s.x : (img.x || 0)) * scaleX);
          const y = Math.round((s.y != null ? s.y : (img.y || 0)) * scaleY);
          const w = Math.round((s.width != null ? s.width : (img.width || 100)) * scaleX);
          const h = Math.round((s.height != null ? s.height : (img.height || 100)) * scaleY);
          const tStart = img.start != null ? img.start : 0;
          const tEnd = tStart + (img.duration != null ? img.duration : (clip.duration || 5));
          const enable = `between(t,${tStart},${tEnd})`;

          inputs += ` -i "${imgPath}"`;
          const inLabel = j === 0 ? '[0:v]' : `[v${j-1}]`;
          const outLabel = j === imageOverlays.length - 1 ? '[vout]' : `[v${j}]`;
          filterComplex += `${inLabel}[${j+1}:v]scale=${w}:${h},overlay=x=${x}:y=${y}:enable='${enable}'${outLabel};`;
        }

        // Remove trailing semicolon
        filterComplex = filterComplex.replace(/;$/, '');

        await runFFmpeg(`ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map 0:a -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${segOut}"`);

      } else if (audioOverlays.length > 0) {
        // Audio mix (with optional image overlays)
        const audioFiles = [];
        for (let j = 0; j < audioOverlays.length; j++) {
          const ao = audioOverlays[j];
          const ap = path.join(dir, `clip${i}_aud${j}.mp3`);
          await download(ao.src, ap);
          audioFiles.push(ap);
        }

        let inputs = `-i "${trimmed}"`;
        audioFiles.forEach(ap => { inputs += ` -i "${ap}"`; });
        const amixInputs = '[0:a]' + audioFiles.map((_, j) => `[${j+1}:a]`).join('');
        const filterComplex = `${amixInputs}amix=inputs=${1 + audioFiles.length}:duration=first[aout]`;

        await runFFmpeg(`ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map 0:v -map "[aout]" -c:v copy "${segOut}"`);
      }

      segmentPaths.push(segOut);
      jobs[jobId].progress = 10 + Math.floor(((i + 1) / videoClips.length) * 65);
    }

    // Concat
    jobs[jobId].message = 'Merging...';
    jobs[jobId].progress = 80;
    const listFile = path.join(dir, 'list.txt');
    fs.writeFileSync(listFile, segmentPaths.map(p => `file '${p}'`).join('\n'));
    const finalOut = path.join(dir, 'final.mp4');
    await runFFmpeg(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalOut}"`);

    jobs[jobId].status = 'done';
    jobs[jobId].progress = 100;
    jobs[jobId].message = 'Render complete';
    jobs[jobId].filePath = finalOut;
    jobs[jobId].dir = dir;

  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].message = err.message;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render server on port ${PORT}`));
