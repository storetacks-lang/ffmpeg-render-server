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

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.post('/render', async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'running', progress: 0, url: null, message: 'Starting...' };
  res.json({ jobId });

  const { output, videoClips, audioTracks } = req.body;
  const dir = path.join(TMP, jobId);
  fs.mkdirSync(dir);

  try {
    const fps = output?.fps || 30;
    const resolution = output?.resolution === '1080p' ? '1920x1080' : '1280x720';

    jobs[jobId].message = 'Downloading clips...';
    jobs[jobId].progress = 10;
    const trimmedPaths = [];

    for (let i = 0; i < (videoClips || []).length; i++) {
      const raw = path.join(dir, `clip${i}_raw.mp4`);
      await download(videoClips[i].src, raw);
      const out = path.join(dir, `clip${i}.mp4`);
      const start = videoClips[i].start || 0;
      const durArg = videoClips[i].duration ? `-t ${videoClips[i].duration}` : '';
      await runFFmpeg(`ffmpeg -y -ss ${start} -i "${raw}" ${durArg} -vf "scale=${resolution},fps=${fps}" -c:v libx264 -preset ultrafast -crf 23 -threads 2 -c:a aac "${out}"`);
      trimmedPaths.push(out);
      jobs[jobId].progress = 10 + Math.floor((i / videoClips.length) * 40);
    }

    jobs[jobId].message = 'Merging clips...';
    jobs[jobId].progress = 60;
    const listFile = path.join(dir, 'list.txt');
    fs.writeFileSync(listFile, trimmedPaths.map(p => `file '${p}'`).join('\n'));
    const concatOut = path.join(dir, 'concat.mp4');
    await runFFmpeg(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${concatOut}"`);

    jobs[jobId].message = 'Adding audio...';
    jobs[jobId].progress = 80;
    const finalOut = path.join(dir, 'final.mp4');
    const firstAudio = (audioTracks || [])[0];
    if (firstAudio?.src) {
      const audioPath = path.join(dir, 'audio.mp3');
      await download(firstAudio.src, audioPath);
      await runFFmpeg(`ffmpeg -y -i "${concatOut}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${finalOut}"`);
    } else {
      fs.copyFileSync(concatOut, finalOut);
    }

    jobs[jobId].status = 'done';
    jobs[jobId].progress = 100;
    jobs[jobId].message = 'Render complete';
    jobs[jobId].filePath = finalOut;
    jobs[jobId].dir = dir;

  } catch (err) {
    jobs[jobId].status = 'error';
    jobs[jobId].message = err.message;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

app.get('/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'done' && job.filePath) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="render_${req.params.jobId}.mp4"`);
    const stream = fs.createReadStream(job.filePath);
    stream.pipe(res);
    stream.on('end', () => {
      fs.rmSync(job.dir, { recursive: true, force: true });
      delete jobs[req.params.jobId];
    });
  } else {
    res.json({ status: job.status, progress: job.progress, url: null, message: job.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render server on port ${PORT}`));
