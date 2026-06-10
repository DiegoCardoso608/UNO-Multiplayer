# 🎴 UNO Multiplayer Online — Regras Brasileiras Configuráveis (BETA)

Jogue UNO online com amigos em partidas em tempo real.

Crie salas privadas, personalize as regras da partida e escolha entre o modo clássico ou as populares regras brasileiras utilizadas em diversas mesas pelo país.

Tudo diretamente pelo navegador, sem necessidade de instalação.

---

# ✨ Recursos

## 🎮 Multiplayer Online

* Salas privadas com código de convite
* Entrada rápida em partidas
* Sincronização em tempo real via Socket.IO
* Reconexão automática de jogadores
* Sistema de host para gerenciamento da sala

---

## 🇧🇷 Regras Brasileiras Configuráveis

O jogo permite ativar ou desativar regras populares utilizadas no Brasil, adaptando a experiência para cada grupo.

### Regras disponíveis

* Empilhar +2
* Empilhar +4
* Empilhamento misto (+2 e +4)
* Regra do 7 (troca de mãos)
* Regra do 0 (rotação de mãos)
* Regra do 9 (bater na mesa)
* Comprar até conseguir jogar
* Jogar múltiplas cartas iguais
* Restrição oficial do +4
* Temporizador de turno
* Destaque para cartas jogáveis

Todas as regras podem ser combinadas livremente antes do início da partida.

---

## 👤 Sistema de Login

* Login como convidado
* Login com Google
* Login com Steam

---

## 📊 Estatísticas

Acompanhe seu desempenho:

* Vitórias
* Derrotas
* Taxa de vitória
* Sequência de vitórias
* Histórico de partidas

---

## 🎨 Personalização

* Planos de fundo personalizados
* Suporte a imagens e vídeos
* Estrutura preparada para futuros pacotes de cartas

---

# 📦 Tecnologias Utilizadas

* Node.js
* Express
* Socket.IO
* Passport.js
* Google OAuth
* Steam OAuth
* HTML5
* CSS3
* JavaScript

---

# 🚀 Instalação

Clone o repositório:

```bash
git clone https://github.com/DiegoCardoso608/UNO-Multiplayer.git
cd UNO-Multiplayer
```

Instale as dependências:

```bash
npm install
```

---

# ⚙️ Configuração

Edite o arquivo:

```txt
config.js
```

Exemplo:

```js
module.exports = {
  PORT: 3000,

  BASE_URL: 'http://localhost:3000',

  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',

  STEAM_API_KEY: '',

  SESSION_SECRET: 'substitua-por-uma-chave-segura'
};
```

---

# ▶️ Executando o Servidor

Modo normal:

```bash
node index.js
```

Modo produção com PM2:

```bash
pm2 start index.js --name uno-multiplayer
```

---

# 🌐 Acessando o Jogo

Após iniciar o servidor:

```txt
http://localhost:3000
```

ou

```txt
http://SEU-IP:3000
```

---

# 🎨 Planos de Fundo Personalizados

Arquivos armazenados em:

```txt
public/background/
```

### Formatos suportados

* JPG
* JPEG
* PNG
* WEBP
* GIF
* MP4
* WEBM
* OGG

### Exemplo

```txt
1.jpg
2.jpg
3.jpg
4.mp4
```

### Evite

* Espaços
* Caracteres acentuados
* Caracteres especiais

---

# 🃏 Pacotes de Cartas

Os arquivos das cartas devem ser armazenados em:

```txt
public/cards/
```

Por questões de direitos autorais, os arquivos originais das cartas não acompanham este repositório.

Você pode criar seu próprio pacote seguindo a convenção de nomes descrita abaixo.

### Cartas Azuis

```txt
Blue_0.png
Blue_1.png
...
Blue_9.png
Blue_Draw.png
```

### Cartas Verdes

```txt
Green_0.png
Green_1.png
...
Green_9.png
Green_Draw.png
```

### Cartas Vermelhas

```txt
Red_0.png
Red_1.png
...
Red_9.png
Red_Draw.png
```

### Cartas Amarelas

```txt
Yellow_0.png
Yellow_1.png
...
Yellow_9.png
Yellow_Draw.png
```

### Coringas

```txt
Wild.png
Wild_Draw.png
```

### Baralho

```txt
Deck.png
```

---

# 📂 Estrutura do Projeto

```txt
UNO-Multiplayer/
│
├── public/
│   ├── background/
│   ├── cards/
│   ├── index.html
│   ├── lobby.html
│   └── game.html
│
├── server/
│   ├── game.js
│   └── db.js
│
├── config.js
├── index.js
├── package.json
└── README.md
```

---

# 🔒 Firewall Ubuntu

```bash
sudo ufw allow 3000/tcp
```

---

# 🐛 Solução de Problemas

## Login Google não funciona

Verifique:

* GOOGLE_CLIENT_ID
* GOOGLE_CLIENT_SECRET
* BASE_URL
* URL de callback configurada no Google

---

## Login Steam não funciona

Verifique:

* STEAM_API_KEY
* BASE_URL
* Domínio registrado na Steam

---

## Porta já está em uso

```bash
sudo lsof -i :3000
```

Depois:

```bash
kill -9 PID
```

---

# 🚧 Roadmap

---

# 📄 Licença

Este projeto foi desenvolvido para fins educacionais e de entretenimento.

Os arquivos das cartas não estão incluídos no repositório e podem estar sujeitos a direitos autorais de terceiros.
