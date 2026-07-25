# video-worker

Render.com'a Docker Web Service olarak deploy edilir.
Env değişkenleri Render dashboard'undan girilir (.env.example'a bak).

Deploy sonrası cron-job.org (ücretsiz) ile şu URL'i her 2-5 dakikada bir çağırt:
https://<render-url>/run-job?secret=WORKER_SECRET
