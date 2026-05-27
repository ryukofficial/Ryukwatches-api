# RyukWatches API

Ad-free anime streaming backend for ryukwatches.vercel.app

## Deploy on Railway (Free)

1. Push this folder to a new GitHub repo called `ryukwatches-api`
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo → Deploy
4. Go to Settings → Networking → Generate Domain
5. Copy your URL and paste it into your site's index.html

## API Endpoints

### Search
```
GET /anime/search?q=one+piece
```

### Anime Info + Episodes
```
GET /anime/info/one-piece
```

### Stream by Episode ID
```
GET /anime/stream/one-piece-episode-1163
```

### Stream by MAL ID + Episode Number
```
GET /anime/stream/mal/21/1163?category=sub
GET /anime/stream/mal/21/1163?category=dub
```

### Proxy m3u8 (CORS-free)
```
GET /proxy/m3u8?url=https://...
```

## Test it works
Open in browser after deploying:
```
https://your-api.up.railway.app/anime/search?q=naruto
```
You should see JSON with anime results.
