// Copyright (c) 2026 Caio Correia | MIT License (see LICENSE)
const { createApp } = require('./index');

const { server } = createApp({ demo: true, autoStart: true });
const port = Number(process.env.PORT) || 3789;
const host = process.env.HOST === undefined || process.env.HOST === '' ? '0.0.0.0' : process.env.HOST;
server.listen(port, host, () => {
  console.log(`WhatsApp Manager (demonstração) em http://${host}:${port}`);
});
