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

function escapeText(text) {
  return (text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

function parsePercent(val, dimension) {
  if (typeof val === 'string' && val.endsWith('%')) {
    return `${dimension}*${parseFloat(val) / 100}`;
  }
  return val || `(${dimension}-text_w)/2`;
}

// Check if file is HEVC and transcode to H264 if needed
async function ensureH264(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`, (err, stdout) => {
      if (err) return reject(err);
      const codec = stdout.trim().toLowerCase();
      if (codec === 'hevc' || codec === 'h265') {
        // Transcode HEVC to H264
        runFFmpeg(`ffmpeg -y -i "${inputPath}" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`)
          .then(resolve).catch(reject);
      } else {
        // Already H264 or compatible — just copy
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

  const { output, videoClips } = req.body;
  const dir = path.join(TMP, jobId);
  fs.mkdirSync(dir);

  try {
    const fps = output?.fps || 30;
    const resolution = output?.resolution === '1080p' ? '1920x1080' : '1280x720';
    const [outW, outH] = resolution.split('x').map(Number);
    const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

    jobs[jobId].message = 'Downloading clips...';
    jobs[jobId].progress = 10;

    const segmentPaths = [];

    for (let i = 0; i < (videoClips || []).length; i++) {
      const clip = videoClips[i];

      // Download raw file
      const raw = path.join(dir, `clip${i}_raw`);
      await download(clip.src, raw);

      // Convert HEVC to H264 if needed
      const converted = path.join(dir, `clip${i}_h264.mp4`);
      await ensureH264(raw, converted);

      // Trim
      const start = clip.start || 0;
      const durArg = clip.duration ? `-t ${clip.duration}` : '';
      const audioArg = clip.audioMuted ? '-an' : '-c:a copy';
      const trimmed = path.join(dir, `clip${i}_trim.mp4`);
      await runFFmpeg(`ffmpeg -y -ss ${start} -i "${converted}" ${durArg} -c:v copy ${audioArg} "${trimmed}"`);

      // Process overlays
      const overlays = clip.overlays || [];
      const textOverlays = overlays.filter(o => o.type === 'text');
      const audioOverlays = overlays.filter(o => o.type === 'audio');
      const segOut = path.join(dir, `seg${i}.mp4`);

      if (textOverlays.length === 0 && audioOverlays.length === 0) {
        fs.copyFileSync(trimmed, segOut);
      } else if (textOverlays.length > 0 && audioOverlays.length === 0) {
        // Text only — vf drawtext
        const drawtextFilters = textOverlays.map(t => {
          const text = escapeText(t.text);
          const fontSize = Math.round((t.settings?.['font-size'] || 22) * (outH / 100));
          const color = (t.settings?.color || '#ffffff').replace('#', '0x') + 'FF';
          const xExpr = parsePercent(t.settings?.x, 'w') + '-text_w/2';
          const yExpr = parsePercent(t.settings?.y, 'h') + '-text_h/2';
          const enable = t.start != null && t.duration != null
            ? `between(t,${t.start},${t.start + t.duration})` : '1';
          return `drawtext=fontfile='${FONT}':text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${xExpr}:y=${yExpr}:enable='${enable}':box=1:boxcolor=black@0.35:boxborderw=6`;
        }).join(',');
        await runFFmpeg(`ffmpeg -y -i "${trimmed}" -vf "${drawtextFilters}" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${segOut}"`);

      } else {
        // Audio overlays (with optional text)
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
        const filterParts = [`${amixInputs}amix=inputs=${1 + audioFiles.length}:duration=first[aout]`];

        if (textOverlays.length > 0) {
          const drawtextFilters = textOverlays.map(t => {
            const text = escapeText(t.text);
            const fontSize = Math.round((t.settings?.['font-size'] || 22) * (outH / 100));
            const color = (t.settings?.color || '#ffffff').replace('#', '0x') + 'FF';
            const xExpr = parsePercent(t.settings?.x, 'w') + '-text_w/2';
            const yExpr = parsePercent(t.settings?.y, 'h') + '-text_h/2';
            const enable = t.start != null && t.duration != null
              ? `between(t,${t.start},${t.start + t.duration})` : '1';
            return `drawtext=fontfile='${FONT}':text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${xExpr}:y=${yExpr}:enable='${enable}':box=1:boxcolor=black@0.35:boxborderw=6`;
          }).join(',');
          filterParts.push(`[0:v]${drawtextFilters}[vout]`);
          await runFFmpeg(`ffmpeg -y ${inputs} -filter_complex "${filterParts.join(';')}" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 23 "${segOut}"`);
        } else {
          await runFFmpeg(`ffmpeg -y ${inputs} -filter_complex "${filterParts.join(';')}" -map 0:v -map "[aout]" -c:v copy "${segOut}"`);
        }
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
