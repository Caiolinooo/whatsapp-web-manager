const { createApp } = require('./index');

const { server } = createApp({ demo: true, autoStart: true });
const port = Number(process.env.PORT) || 3789;
server.listen(port, '127.0.0.1', () => {
  console.log(`WhatsApp Manager (demonstração) em http://127.0.0.1:${port}`);
});
