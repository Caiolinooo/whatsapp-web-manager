# WhatsApp Manager

App local. O servidor escuta só em `127.0.0.1:3789`.

## Subir

1. Instalar dependências: `npm install` na pasta `whatsapp-web-manager`.
2. Iniciar de verdade: `npm start`.
3. Abrir `http://127.0.0.1:3789`.
4. Modo sem celular e sem login, só para ensaio da interface: `npm run demo`.
5. No Linux o programa usa o Chrome ou o Chromium do sistema: `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser` ou `/snap/bin/chromium`. `CHROME_PATH` continua valendo antes desses caminhos.

## Login

1. No primeiro `npm start`, a tela pede um administrador. Usuário: 3 a 32 letras, números, ponto, `_` ou `-`. Senha: 8 a 200 caracteres.
2. A sessão fica num cookie `HttpOnly` por 14 dias. Sair do app encerra essa sessão.
3. Oito senhas erradas do mesmo endereço travam novas tentativas por 10 minutos.
4. Quem é administrador abre Acessos e cria, desativa ou exclui outras pessoas. Usuário comum não vê essa tela.
5. Senha troca a senha de quem está logado e derruba as outras sessões dessa pessoa.
6. Sem login, a API responde 401. A demonstração não usa essa trava.

## Números

1. Números adiciona outro WhatsApp. Cada um abre o próprio navegador e guarda a sessão em `data/accounts/<id>`.
2. Dê um nome curto para reconhecer o chip. Dá para renomear, desconectar ou remover.
3. Remover apaga a sessão local e o cache daquele número. Não apaga a conta no celular.
4. O limite é 8 números nesta máquina.
5. Se já existir `data/session` de uma versão anterior, o próximo start leva essa sessão para o número Principal. Se o Windows recusar porque a pasta está em uso, o programa sobe mesmo assim e esse número continua em `data/session`. Feche o Chrome que ficou aberto e inicie de novo para concluir a mudança.
6. Conectar, se ainda não houver número, cria o Principal e mostra o QR.
7. No celular: WhatsApp, Dispositivos conectados, Conectar dispositivo. Outra sessão Web aberta cede o lugar.

## Conversas

1. A lista mostra foto, nome e número. Grupo mostra a palavra Grupo.
2. O mesmo telefone em números diferentes aparece uma vez só. A bolha diz de qual número a mensagem saiu, e o envio pede qual número responde.
3. O filtro do topo da lista é imediato, por nome ou número, no que já foi carregado.
4. Pesquisar consulta o índice do cache: mensagens, arquivos ou conversas, com opção de um número só.
5. Clicar na linha abre a conversa unida. A caixa marca a conversa para exportação e backup.
6. Shift na lista marca o intervalo entre a última conversa marcada e a clicada.

## Cache

1. O que chegar depois de conectado entra em `data/cache`. Abrir uma conversa também grava as mensagens carregadas.
2. Isso não puxa sozinho o histórico antigo. Para indexar o passado, abra a conversa ou carregue mais.
3. O contador no topo mostra quantas mensagens e arquivos já estão no índice.
4. Mídia recebida é baixada para o cache em segundo plano, uma por vez.

## Envio

1. Com a conversa aberta, o rodapé envia texto, imagem, vídeo, áudio, voz, arquivo, figurinha, local ou contato.
2. Arquivo até 80 MB. Voz sai como mensagem de voz. Figurinha pede uma imagem.
3. Se a conversa existir em mais de um número, escolha qual envia.
4. A mensagem enviada entra no cache e na conversa aberta.

## Anexos, HTML e backup

1. Exportar esta conversa, ou marcar várias e usar Baixar anexos e HTML.
2. A pasta fica em `data/exports/<nome>/<número>/<tipo>/`.
3. Tipos: `imagens`, `videos`, `audios`, `documentos`, `figurinhas`, `outros`.
4. Grupo usa a pasta `grupo` no lugar do número.
5. `conversa.html` imita o visual do WhatsApp e aponta para os arquivos ao lado. Abre sem internet.
6. Backup grava a conversa unida em `data/backups/<data>/`, com `manifest.json`, `mensagens.json` e os anexos que o WhatsApp ainda entrega.
7. A extração lê até 2000 mensagens recentes de cada número. Mídia expirada entra como indisponível.

## Excluir mensagens

1. Abrir a conversa.
2. Clicar numa mensagem. Shift clica outra: o intervalo fica selecionado.
3. Ctrl clica para somar ou tirar uma mensagem.
4. Excluir pede confirmação.
5. Sem a opção "para todos", a exclusão vale para o número de onde a mensagem saiu.
6. "Excluir para todos" só vale para mensagens suas que o WhatsApp ainda aceita apagar. Não tem volta.

## Verificação

1. `npm test` cobre seleção, pastas, HTML, cache, busca, backup, login e a tela no Chrome.
2. O teste de tela usa dados de demonstração. O QR real depende do celular.
