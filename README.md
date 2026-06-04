# 🎴 UNO Online

Um jogo de UNO multiplayer em tempo real desenvolvido com Node.js, Express e Socket.IO.

Crie salas privadas, personalize as regras da partida e jogue diretamente pelo navegador com seus amigos.

---

## ✨ Recursos

### 🎮 Multiplayer Online

* Salas privadas por código
* Entrada rápida em partidas
* Sincronização em tempo real via Socket.IO
* Reconexão automática

### 👤 Sistema de Login

* Login como convidado
* Login com Google
* Login com Steam

### 📊 Estatísticas

* Vitórias e derrotas
* Taxa de vitória
* Sequência de vitórias
* Histórico de partidas

### 🎨 Personalização

* Backgrounds personalizados
* Suporte a imagens e vídeos
* Sistema preparado para múltiplos pacotes de cartas

### ⚙️ Regras Configuráveis

O host pode ativar ou desativar regras antes da partida:

* Empilhar +2
* Empilhar +4
* Empilhamento misto (+2 e +4)
* Regra do 7 (troca de mãos)
* Regra do 0 (rotação de mãos)
* Regra do 9 (bater na mesa)
* Compra até jogar
* Jogar múltiplas cartas iguais
* Restrição oficial do +4
* Temporizador de turno
* Destaque visual para cartas jogáveis

---

## 📦 Tecnologias

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

## 🚀 Instalação

Clone o repositório:

```bash
git clone https://github.com/SEU_USUARIO/UNO-Online.git
cd UNO-Online
```

Instale as dependências:

```bash
npm install
```

---

## ⚙️ Configuração

Edite o arquivo:

```bash
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

  SESSION_SECRET: 'troque-esta-chave'
};
```

---

## ▶️ Executando

Modo normal:

```bash
node index.js
```

Modo produção com PM2:

```bash
pm2 start index.js --name uno-online
```

---

## 🌐 Acesso

Após iniciar o servidor:

```txt
http://localhost:3000
```

ou

```txt
http://SEU-IP:3000
```

---

## 🎨 Backgrounds Personalizados

Os backgrounds ficam em:

```txt
public/background/
```

Formatos suportados:

* JPG
* JPEG
* PNG
* WEBP
* GIF
* MP4
* WEBM
* OGG

Recomendação:

```txt
1.jpg
2.jpg
3.jpg
4.mp4
```

Evite:

* Espaços
* Acentos
* Caracteres especiais

---

## 🃏 Pacotes de Cartas

As cartas ficam em:

```txt
public/cards/
```

Por questões de direitos autorais, os assets originais não acompanham este repositório.

Você pode criar seu próprio conjunto de cartas seguindo o padrão de nomenclatura utilizado pelo projeto.

O sistema foi desenvolvido para futuramente suportar múltiplos pacotes de cartas.

Para utilizar um pacote personalizado, siga a nomenclatura abaixo:

Blue_0.png
Blue_1.png
Blue_2.png
Blue_3.png
Blue_4.png
Blue_5.png
Blue_6.png
Blue_7.png
Blue_8.png
Blue_9.png
Blue_Skip.png
Blue_Reverse.png
Blue_Draw.png

Green_0.png
Green_1.png
Green_2.png
Green_3.png
Green_4.png
Green_5.png
Green_6.png
Green_7.png
Green_8.png
Green_9.png
Green_Skip.png
Green_Reverse.png
Green_Draw.png


Red_0.png
Red_1.png
Red_2.png
Red_3.png
Red_4.png
Red_5.png
Red_6.png
Red_7.png
Red_8.png
Red_9.png
Red_Skip.png
Red_Reverse.png
Red_Draw.png


Yellow_0.png
Yellow_1.png
Yellow_2.png
Yellow_3.png
Yellow_4.png
Yellow_5.png
Yellow_6.png
Yellow_7.png
Yellow_8.png
Yellow_9.png
Yellow_Skip.png
Yellow_Reverse.png
Yellow_Draw.png


Wild.png
Wild_Draw.png
Deck.png

---

## 📂 Estrutura

```txt
UNO-Online/
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

## 🔒 Firewall (Ubuntu)

```bash
sudo ufw allow 3000/tcp
```

---

## 🐛 Problemas Comuns

### Login Google não funciona

Verifique:

* GOOGLE_CLIENT_ID
* GOOGLE_CLIENT_SECRET
* BASE_URL
* URL de callback cadastrada

### Login Steam não funciona

Verifique:

* STEAM_API_KEY
* BASE_URL
* Domínio cadastrado na Steam

### Porta já está em uso

```bash
sudo lsof -i :3000
```

Depois:

```bash
kill -9 PID
```

---

## 📄 Licença

Projeto criado para fins educacionais e de entretenimento.

Os assets gráficos utilizados não acompanham este repositório.
