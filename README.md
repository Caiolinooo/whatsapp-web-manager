# WhatsApp Manager

Versão 1.0.1. Licença [MIT](LICENSE).

Vários números de WhatsApp Web no mesmo computador. As mensagens que chegam depois da conexão ficam em cache. A busca usa esse índice. Cada conversa pode ser exportada em HTML ou guardada em backup. O acesso pede login.

O passo a passo da tela está em [tasks.md](tasks.md).

## Onde este programa roda

Roda num computador com Node.js e Google Chrome (ou Chromium) abertos o tempo todo. A sessão do WhatsApp fica em disco. O navegador da sessão também fica aberto enquanto o número está conectado.

Não rode na Vercel, nem noutro hosting serverless. Esse tipo de serviço apaga o disco entre invocações, limita o tempo do processo e não mantém o Chrome. Sem isso o QR não completa e a sessão se perde. Um registo DNS, incluindo SRV, também não publica o programa: o browser não consulta SRV para abrir um site.

O servidor escuta em `0.0.0.0` (todas as interfaces). A porta padrão é `3789`. Quem alcança essa porta na rede ou na internet chega no programa. O login continua obrigatório no `npm start`.

## Requisitos

- Node.js 18 ou mais novo
- Google Chrome ou Microsoft Edge no Windows, ou Chrome/Chromium no Linux
- Um celular com WhatsApp para ler o QR

No Linux o programa procura, nesta ordem, `CHROME_PATH`, `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser` e `/snap/bin/chromium`.

## Instalar e iniciar

```bash
npm install
npm start
```

Abra http://127.0.0.1:3789 nesta máquina, ou `http://IP-PÚBLICO:3789` de fora (roteador com encaminhamento da porta 3789). No primeiro acesso, crie o administrador. Depois conecte cada número e leia o QR no celular: WhatsApp, Dispositivos conectados, Conectar dispositivo. Outra sessão Web aberta cede o lugar.

Ensaio da interface, sem celular e sem login:

```bash
npm run demo
```

Testes:

```bash
npm test
```

O teste de tela usa o Chrome instalado e dados de demonstração. O QR real depende do celular.

## Variáveis

| Variável | Efeito |
| --- | --- |
| `PORT` | Porta HTTP. Padrão `3789`. |
| `HOST` | Interface de escuta. Padrão `0.0.0.0` (internet e LAN). `127.0.0.1` trava de novo só nesta máquina. |
| `CHROME_PATH` | Caminho do Chrome ou do Chromium. Vale antes da procura automática. |
| `HEADFUL` | `1` abre o Chrome com janela. O padrão é headless. |
| `DEMO` | `1` sobe a demonstração, o mesmo que `npm run demo`. |

Não use porta de depuração remota do Chrome. O programa não abre `9333`.

## Login

1. No primeiro `npm start`, a tela pede um administrador. Usuário: 3 a 32 letras, números, ponto, `_` ou `-`. Senha: 8 a 200 caracteres.
2. A sessão fica num cookie `HttpOnly` por 14 dias. Sair do app encerra essa sessão.
3. Oito senhas erradas do mesmo endereço travam novas tentativas por 10 minutos.
4. Quem é administrador abre Acessos e cria, desativa ou exclui outras pessoas. Usuário comum não vê essa tela.
5. Trocar a senha vale para quem está logado e derruba as outras sessões dessa pessoa.
6. Sem login, a API responde 401. A demonstração não usa essa trava.
7. Em Acessos, o administrador atribui números a cada pessoa. Todo mundo vê todas as conversas, mas o envio só sai pelos números atribuídos a quem está logada. Administrador envia por qualquer número. Conversa de número não atribuído abre em modo somente leitura.

## Números

1. Números adiciona outro WhatsApp. Cada um abre o próprio navegador e guarda a sessão em `data/accounts/<id>`.
2. Dê um nome curto para reconhecer o chip. Dá para renomear, desconectar ou remover.
3. Remover apaga a sessão local e o cache daquele número. Não apaga a conta no celular.
4. O limite é 8 números nesta máquina.
5. Se já existir `data/session` de uma versão anterior, o próximo start leva essa sessão para o número Principal. Se o Windows recusar porque a pasta está em uso, o programa sobe mesmo assim e esse número continua em `data/session`. Feche o Chrome que ficou aberto e inicie de novo para concluir a mudança.
6. Conectar, se ainda não houver número, cria o Principal e mostra o QR.

## Conversas, cache e envio

A lista mostra foto, nome e número. Grupo mostra a palavra Grupo. O mesmo telefone em números diferentes aparece uma vez só. A bolha diz de qual número a mensagem saiu, e o envio pede qual número responde.

O filtro do topo da lista é imediato, por nome ou número, no que já foi carregado. Pesquisar consulta o índice do cache: mensagens, arquivos ou conversas, com opção de um número só. Shift na lista marca o intervalo entre a última conversa marcada e a clicada.

O que chegar depois de conectado entra em `data/cache`. Abrir uma conversa também grava as mensagens carregadas. Isso não puxa sozinho o histórico antigo. Mídia recebida é baixada para o cache em segundo plano, uma por vez.

Com a conversa aberta, o rodapé envia texto, imagem, vídeo, áudio, voz, arquivo, figurinha, local ou contato. Arquivo até 80 MB. Voz sai como mensagem de voz. Figurinha pede uma imagem. A mensagem enviada entra no cache e na conversa aberta.

O botão de microfone do rodapé grava áudio pelo navegador e envia como mensagem de voz. Áudios recebidos tocam na própria conversa. O botão Transcrever converte áudio em texto com o whisper.cpp local (modelo em `bin/whisper`), sem enviar nada para fora da máquina. A transcrição fica em cache em `data/cache/transcripts`. Precisa de `ffmpeg` no PATH e dos arquivos de `bin/whisper` (baixados de ggerganov/whisper.cpp). `WHISPER_CLI`, `WHISPER_MODEL`, `WHISPER_LANG` e `WHISPER_DIR` trocam esses caminhos.

## Exportação, backup e exclusão

Exportar esta conversa, ou marcar várias e usar Baixar anexos e HTML. A pasta fica em `data/exports/<nome>/<número>/<tipo>/`. Os tipos são `imagens`, `videos`, `audios`, `documentos`, `figurinhas` e `outros`. Grupo usa a pasta `grupo` no lugar do número. `conversa.html` imita o visual do WhatsApp, aponta para os arquivos ao lado e abre sem internet.

Backup grava a conversa unida em `data/backups/<data>/`, com `manifest.json`, `mensagens.json` e os anexos que o WhatsApp ainda entrega. A extração lê até 2000 mensagens recentes de cada número. Mídia expirada entra como indisponível.

Para apagar, abra a conversa e clique numa mensagem. Shift marca o intervalo. Ctrl soma ou tira uma mensagem. Excluir pede confirmação. Sem a opção "para todos", a exclusão vale para o número de onde a mensagem saiu. "Excluir para todos" só vale para mensagens suas que o WhatsApp ainda aceita apagar. Não tem volta.

## Dados que não vão para o git

`data/` guarda sessão, cache, exportação, backup e `auth.json`. `.wwebjs_cache/` é cache do WhatsApp Web. Os dois ficam de fora do repositório.
