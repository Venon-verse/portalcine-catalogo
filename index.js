const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const express = require('express');
const axios = require('axios');

// Inicializações
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const bot = new Telegraf(process.env.BOT_TOKEN);
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const payment = new Payment(mpClient);

const urlDoCatalogo = 'https://venon-verse.github.io/portalcine-catalogo/';

// 🔥 LINK DA RENDER CONFIGURADO 🔥
const LINK_DA_RENDER = 'https://portalcine-bot-online.onrender.com';

// ==========================================
// SERVIDOR WEB E WEBHOOK (Ouvido Biônico)
// ==========================================
const app = express();
app.use(express.json()); 

app.get('/', (req, res) => res.send('PortalCine Bot está Online na Nuvem!'));

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const { type, data } = req.body;
    
    if (type === 'payment' && data && data.id) {
        try {
            const statusPgto = await payment.get({ id: data.id });
            
            if (statusPgto.status === 'approved') {
                const [chatIdStr, filmeId] = statusPgto.external_reference.split('_');
                const chatId = parseInt(chatIdStr);

                const doc = await db.collection('filmes').doc(filmeId).get();
                if (!doc.exists) return; 
                const filme = doc.data();

                const link = await bot.telegram.createChatInviteLink(filme.idGrupo, { member_limit: 1 });
                const imagem = filme.urlCapa || `https://placehold.co/300x450/222/fff?text=${encodeURIComponent(filme.titulo)}`;

                await bot.telegram.sendPhoto(chatId, imagem, {
                    caption: `🎉 *PAGAMENTO APROVADO!*\n\nMuito obrigado pela compra! 🍿\nVocê adquiriu o acesso vitalício a: *${filme.titulo}*\n\n👇 *SEU ACESSO EXCLUSIVO:*\nClique no botão abaixo para entrar no canal.\n\n⚠️ *Atenção:* Este link é único e só funciona para si (1 uso).`,
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.url('🎬 ENTRAR NO CANAL DO FILME', link.invite_link)]
                    ])
                });
            }
        } catch (error) {
            console.error("Erro no Webhook:", error);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor a escutar na porta ${PORT}`));

// ==========================================
// CADASTRO DE FILMES PELO TELEGRAM
// ==========================================
bot.on('photo', async (ctx) => {
    const legenda = ctx.message.caption || '';
    if (legenda.startsWith('/filmes add')) {
        try {
            const partes = legenda.split(' ');
            if (partes.length >= 6) {
                const [,, categoria, preco, idGrupo, ...nome] = partes;
                const titulo = nome.join(' ');
                const msg = await ctx.reply('⏳ A processar capa e enviar para o banco de dados...');

                const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                const fileLink = await ctx.telegram.getFileLink(photoId);
                const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
                const imgBase64 = Buffer.from(response.data).toString('base64');

                const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_KEY}`, new URLSearchParams({ image: imgBase64 }));
                
                await db.collection('filmes').add({
                    titulo, categoria, idGrupo, 
                    preco: parseFloat(preco), 
                    urlCapa: imgbb.data.data.url,
                    dataCadastro: admin.firestore.FieldValue.serverTimestamp()
                });

                await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ "${titulo}" registado com sucesso!`);
            } else {
                ctx.reply('❌ Formato incorreto. Use: /filmes add [Categoria] [Preco] [IdGrupo] [Titulo]');
            }
        } catch (e) { 
            console.error(e);
            ctx.reply('❌ Erro no registo.'); 
        }
    }
});

// ==========================================
// COMANDOS DE COMPRA E CATÁLOGO
// ==========================================
bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    if (payload && payload.startsWith('comprar_')) {
        const filmeId = payload.split('_')[1];
        const doc = await db.collection('filmes').doc(filmeId).get();
        const filme = doc.data();
        
        // 🚨 VERIFICA SE É GRATUITO AQUI 🚨
        if (filme.preco === 0) {
            return ctx.reply(`🍿 *Filme:* ${filme.titulo}\n🎁 *Valor:* TOTALMENTE GRÁTIS!`, 
                Markup.inlineKeyboard([[Markup.button.callback('🎁 Resgatar Acesso Grátis', `pagar_${filmeId}`)]]));
        } else {
            return ctx.reply(`🍿 *Filme:* ${filme.titulo}\n💰 *Valor:* R$ ${filme.preco.toFixed(2)}`, 
                Markup.inlineKeyboard([[Markup.button.callback('💎 Gerar PIX Agora', `pagar_${filmeId}`)]]));
        }
    }
    ctx.reply('🎬 Bem-vindo ao PortalCine!', Markup.inlineKeyboard([Markup.button.webApp('🍿 Abrir Catálogo', urlDoCatalogo)]));
});

bot.action(/pagar_(.+)/, async (ctx) => {
    const filmeId = ctx.match[1];
    try {
        const doc = await db.collection('filmes').doc(filmeId).get();
        const filme = doc.data();
        
        // 🚨 ENTREGA IMEDIATA SE FOR GRATUITO 🚨
        if (filme.preco === 0) {
            await ctx.reply('⏳ A gerar o seu acesso gratuito...');
            
            const link = await bot.telegram.createChatInviteLink(filme.idGrupo, { member_limit: 1 });
            const imagem = filme.urlCapa || `https://placehold.co/300x450/222/fff?text=${encodeURIComponent(filme.titulo)}`;

            await bot.telegram.sendPhoto(ctx.chat.id, imagem, {
                caption: `🎉 *ACESSO GRATUITO LIBERADO!*\n\nMuito obrigado por usar o nosso bot! 🍿\nResgatou o acesso vitalício a: *${filme.titulo}*\n\n👇 *SEU ACESSO EXCLUSIVO:*\nClique no botão abaixo para entrar no canal.\n\n⚠️ *Atenção:* Este link é único e só funciona para si (1 uso).`,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🎬 ENTRAR NO CANAL DO FILME', link.invite_link)]
                ])
            });
            return; // Termina a função aqui para não gerar o PIX!
        }

        // SE NÃO FOR GRATUITO, GERA O PIX NORMALMENTE
        const body = {
            transaction_amount: filme.preco,
            description: `PortalCine: ${filme.titulo}`,
            payment_method_id: 'pix',
            payer: { email: 'suporte@portalcine.com' },
            external_reference: `${ctx.chat.id}_${filmeId}`, 
            notification_url: `${LINK_DA_RENDER}/webhook` 
        };

        const response = await payment.create({ body });
        const copiaCola = response.point_of_interaction.transaction_data.qr_code;

        await ctx.reply(`\`${copiaCola}\``, { parse_mode: 'Markdown' });
        await ctx.reply('⏳ *A aguardar pagamento...* Pode fechar o Telegram, nós avisaremos quando o pagamento for compensado!');

    } catch (error) {
        ctx.reply('❌ Erro ao gerar acesso ou PIX.');
    }
});

bot.launch().then(() => console.log('🚀 PortalCine Master Online com Webhook e Filmes Grátis!'));