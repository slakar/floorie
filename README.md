# Gridline

A zero-build browser floor-plan editor with a small PHP API for JSON-file storage.

## Requirements

- Apache or Nginx
- PHP 7.4 or newer
- Write access for the PHP/web-server user to `data/`

No Node.js, build process, or database is required.

## Deploy

Point the web server at this directory and ensure PHP handles `.php` files. Then make the storage directory writable by the PHP user:

```bash
sudo chown -R www-data:www-data data
sudo chmod 770 data
```

Apache protects `data/` using its included `.htaccess`. For Nginx, add this inside the site/server block so stored plans cannot be downloaded directly:

```nginx
location ^~ /data/ {
    deny all;
}
```

For stronger separation, set the `GRIDLINE_DATA_DIR` environment variable to a writable directory outside the public web root.

## Files

- `index.html`, `styles.css`, `app.js` — zero-build frontend
- `api.php` — same-origin save/list/load API
- `data/*.json` — server-saved plan envelopes

Plans also autosave locally in the browser and can be downloaded or loaded as portable JSON files. Server saves preserve walls, text labels, measurements, grid settings, and viewport state.

## Security

The API intentionally has no user accounts and is suitable for a trusted private network. Anyone who can reach the app can list, open, and overwrite its server plans. Put the site behind web-server authentication before exposing it to an untrusted network or the public internet.
