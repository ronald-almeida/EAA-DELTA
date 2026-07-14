// /api/create-pix.js
// Endpoint serverless (Vercel) que recebe os dados do checkout e cria
// a transação PIX na PayShark. A SECRET_KEY nunca fica exposta no front-end,
// e os preços são fixos aqui no servidor (nunca confiamos no valor vindo do front).
//
// Configure na Vercel (Project Settings > Environment Variables):
//   PAYSHARK_SECRET_KEY = sk_xxx_sua_chave_secreta
//
// Documentação: https://app.paysharkgateway.com.br/docs/sales/create-sale

export default async function handler(req, res) {
  // CORS básico - ajuste o domínio do seu checkout em produção se quiser travar mais
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  try {
    const {
      nome,
      email,
      cpf,
      celular,
      bumpAtivo,
      externalRef,
    } = req.body || {};

    // ---- Validações básicas no servidor (nunca confie só no front) ----
    if (!nome || typeof nome !== 'string' || nome.trim().length < 3) {
      return res.status(400).json({ error: 'Nome inválido.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    const cpfLimpo = String(cpf || '').replace(/\D/g, '');
    if (!validarCPF(cpfLimpo)) {
      return res.status(400).json({ error: 'CPF inválido.' });
    }
    const celularLimpo = String(celular || '').replace(/\D/g, '');
    if (celularLimpo.length < 10) {
      return res.status(400).json({ error: 'Celular inválido.' });
    }

    // ---------------------------------------------------------------
    // SEGURANÇA: os preços SÃO FIXOS AQUI NO SERVIDOR, nunca recebidos
    // do front-end. O front só informa se o order bump foi marcado
    // (true/false) - ele não manda "quanto custa". Isso impede que
    // alguém abra o DevTools, edite o JS do checkout e mande um valor
    // menor pro backend.
    // ---------------------------------------------------------------
    const PRECO_PRODUTO_CENTAVOS = 69700; // R$ 697,00
    const PRECO_BUMP_CENTAVOS = 19700; // R$ 197,00
    const NOME_PRODUTO = 'Acesso Total Delegado de Polícia - 02 Anos';
    const NOME_BUMP = 'Acesso Total Vitalício - Delegado de Polícia 2.0';

    const bumpSelecionado = bumpAtivo === true;

    // ---- Monta os itens da venda ----
    const items = [
      {
        title: NOME_PRODUTO,
        unitPrice: PRECO_PRODUTO_CENTAVOS,
        quantity: 1,
        tangible: false,
      },
    ];

    let totalCentavos = PRECO_PRODUTO_CENTAVOS;

    if (bumpSelecionado) {
      items.push({
        title: NOME_BUMP,
        unitPrice: PRECO_BUMP_CENTAVOS,
        quantity: 1,
        tangible: false,
      });
      totalCentavos += PRECO_BUMP_CENTAVOS;
    }

    const payload = {
      paymentMethod: 'pix',
      currency: 'BRL',
      amount: totalCentavos,
      items,
      customer: {
        name: nome,
        email,
        phone: celularLimpo,
        document: {
          type: cpfLimpo.length === 11 ? 'cpf' : 'cnpj',
          number: cpfLimpo,
        },
      },
      pix: {
        expiresInDays: 1,
      },
      externalRef: externalRef || `venda-${Date.now()}`,
      // postbackUrl: 'https://SEU-PROJETO.vercel.app/api/webhook', // recomendado, ver observação abaixo
    };

    const secretKey = process.env.PAYSHARK_SECRET_KEY;
    if (!secretKey) {
      console.error('PAYSHARK_SECRET_KEY não configurada nas variáveis de ambiente.');
      return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
    }

    // Basic Auth: base64("secretKey:") - conforme exemplo curl da PayShark
    const authHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');

    const psResponse = await fetch('https://api.paysharkgateway.com.br/v1/transactions', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await psResponse.json();

    if (!psResponse.ok) {
      console.error('Erro PayShark:', data);
      return res.status(psResponse.status).json({
        error: data?.message || data?.error || 'Erro ao criar transação na PayShark.',
        details: data,
      });
    }

    // Formato confirmado na doc da PayShark (200 response):
    // data.pix.qrcode, data.pix.expirationDate, data.pix.end2EndId, data.pix.receiptUrl
    const qrcode = data?.pix?.qrcode || null;
    const expirationDate = data?.pix?.expirationDate || null;
    const end2EndId = data?.pix?.end2EndId || null;

    if (!qrcode) {
      console.error('Resposta da PayShark sem pix.qrcode:', data);
      return res.status(502).json({
        error: 'Transação criada, mas o Pix não retornou QR Code. Tente novamente.',
        details: data,
      });
    }

    return res.status(200).json({
      id: data.id,
      status: data.status, // pending | paid | refunded | refused
      amount: data.amount,
      qrcode,
      expirationDate,
      end2EndId,
    });
  } catch (err) {
    console.error('Erro inesperado em /api/create-pix:', err);
    return res.status(500).json({ error: 'Erro interno ao gerar o Pix. Tente novamente.' });
  }
}

function validarCPF(cpf) {
  cpf = String(cpf).replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let soma = 0,
    resto;
  for (let i = 1; i <= 9; i++) soma += parseInt(cpf[i - 1]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[9])) return false;
  soma = 0;
  for (let i = 1; i <= 10; i++) soma += parseInt(cpf[i - 1]) * (12 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(cpf[10]);
}
