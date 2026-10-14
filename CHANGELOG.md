# Changelog

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [1.2.0] - 2026-10-14

### Adicionado

- Lixeira no servidor: mensagens apagadas pelo app ou revogadas no celular ("Apagar para todos") são arquivadas em `data/trash` com mídia, motivo e data. Na lixeira (botão 🗑 no topo) é possível restaurar para o cache, restaurar e re-enviar para o WhatsApp (volta como mensagem nova com aviso de restauração) ou excluir definitivamente.
- Backup proativo de mídia: toda mídia recebida (ao vivo ou pelo histórico) é baixada em segundo plano, garantindo cópia mesmo se for apagada no celular depois.

### Alterado

- Transcrição de áudio agora usa o servidor de voz da VM (`WHISPER_API_URL` no `.env`), com VAD e beam search — fim das alucinações de "[MÚSICA]" e repetições do modelo local. Se a VM estiver fora, cai no whisper.cpp local como antes.
- Somente o dono do número (ou o administrador) pode apagar mensagens: o servidor bloqueia com 403 e o botão de apagar some para quem não tem permissão.

## [1.1.1] - 2026-10-14

### Corrigido

- Envio de texto, áudio e arquivos voltou a funcionar após o WhatsApp Web publicar builds 2.3000.10503x que quebravam o whatsapp-web.js 1.34.7: a biblioteca agora vem da branch principal (commit 064a3d5), compatível com as builds novas, e a versão fixa do WA Web foi removida.
- Mensagem de voz gravada no navegador (WebM) é convertida para OGG/Opus com ffmpeg antes do envio, formato exigido pelo WhatsApp para nota de voz.
- Campo de envio no estilo do WhatsApp: botão de anexo (+) com menu, chip de arquivo selecionado e alternância microfone/enviar conforme o texto.
- `npm start` reserva heap maior (4 GB) para evitar encerramento por falta de memória na inicialização.

## [1.1.0] - 2026-10-14

### Adicionado

- Envio restrito por número: o administrador atribui números a cada usuário em Acessos; usuário comum só envia pelos números atribuídos e vê o resto em somente leitura. Administrador envia por todos.
- Gravação de mensagem de voz pelo navegador e player de áudio nas mensagens recebidas.
- Transcrição de áudio local com whisper.cpp (`bin/whisper`), com cache em `data/cache/transcripts`.
- Visual novo das telas (tema escuro, bolhas e login redesenhados).

## [1.0.1] - 2026-10-14

### Corrigido

- O programa encontra Google Chrome e Chromium no Linux, além dos caminhos do Windows. `CHROME_PATH` continua na frente.

## [1.0.0] - 2026-10-14

### Adicionado

- Vários números de WhatsApp Web no mesmo computador, com cache, busca, exportação em HTML, backup e login local.
