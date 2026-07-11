# Outpost Duel

A 2-player worker-placement duel — 8 board sites, each with a free Basic action
and a pricier Advanced one, a hidden-card Skirmish, and an Influence track.
Play hotseat on one screen, watch two bots in Demo mode, or host/join a room
to play online from two separate devices.

## Run locally

```
npm install
node server.js
```

Then open http://localhost:8642 (or whatever port `PORT` is set to).

## Deploy for free (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rkajaria-1507/outpost-duel)

Click the button, sign in with GitHub (free), and Render will build and run
this repo using `render.yaml`. You'll get a public URL like
`https://outpost-duel-xxxx.onrender.com` — share that with whoever you're
playing with and pick "Online — Host a room" / "Online — Join a room".

Free-tier services on Render spin down after ~15 minutes idle and take a few
seconds to wake back up on the next visit — normal for a free hobby deploy.
