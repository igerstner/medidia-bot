const express = require('express');
const twilio = require('twilio');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Inicializar Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MessagingResponse = twilio.twiml.MessagingResponse;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

app.post('/bot', async (req, res) => {
  const twiml = new MessagingResponse();
  const mensaje = (req.body.Body || '').trim().toLowerCase();
  const fromRaw = req.body.From || '';
  // From llega como "whatsapp:+5493XXXXXXXXX"
  const telefono = fromRaw.replace('whatsapp:', '');

  try {
    const uid = await obtenerUidPorTelefono(telefono);
    let respuesta = '';

    if (!uid) {
      respuesta = '⚠️ No encontré tu cuenta MediDía. Asegurate de estar registrado con este número.';
    } else if (mensaje.includes('turno') || mensaje.includes('turnos')) {
      respuesta = await obtenerTurnos(uid);
    } else if (mensaje.includes('medicamento') || mensaje.includes('pastilla') || mensaje.includes('remedio')) {
      respuesta = await obtenerMedicamentos(uid);
    } else if (mensaje.includes('stock')) {
      respuesta = await obtenerStockBajo(uid);
    } else {
      respuesta = `👋 Hola! Soy el asistente de MediDía.\n\nPodés consultarme:\n• *turnos* → próximos turnos médicos\n• *medicamentos* → medicamentos del día\n• *stock* → medicamentos con stock bajo`;
    }

    twiml.message(respuesta);
  } catch (error) {
    console.error(error);
    twiml.message('Hubo un error al consultar la información. Intentá de nuevo.');
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

app.post('/enviar-codigo', async (req, res) => {
  const { telefono, codigo, nombreSolicitante } = req.body;
  if (!telefono || !codigo || !nombreSolicitante) {
    return res.status(400).json({ ok: false, error: 'Parámetros faltantes' });
  }
  try {
    const destino = telefono.startsWith('whatsapp:') ? telefono : `whatsapp:${telefono}`;
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: destino,
      body:
        `🔐 Tu código de verificación MediDía es: ${codigo}\n` +
        `${nombreSolicitante} quiere vincularse con vos.\n` +
        `Este código expira en 10 minutos.`,
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error enviando código:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('MediDía Bot corriendo ✅'));

async function obtenerUidPorTelefono(telefono) {
  if (!telefono) return null;
  const snapshot = await db.collection('usuarios').where('telefono', '==', telefono).get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}

async function obtenerTurnos(userId) {
  const snapshot = await db.collection('turnos').where('userId', '==', userId).get();
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const proximos = snapshot.docs
    .map(doc => doc.data())
    .filter(t => {
      const fecha = parsearFecha(t.fecha);
      return fecha && fecha >= hoy;
    })
    .sort((a, b) => parsearFecha(a.fecha) - parsearFecha(b.fecha))
    .slice(0, 3);

  if (proximos.length === 0) return '📅 No hay turnos próximos agendados.';

  const lista = proximos.map(t =>
    `📅 ${t.especialidad} - ${t.fecha} a las ${t.hora}hs${t.medico ? `\n   👨‍⚕️ ${t.medico}` : ''}${t.lugar ? `\n   📍 ${t.lugar}` : ''}`
  ).join('\n\n');

  return `🏥 *Próximos turnos:*\n\n${lista}`;
}

async function obtenerMedicamentos(userId) {
  const snapshot = await db.collection('medicamentos').where('userId', '==', userId).get();
  const medicamentos = snapshot.docs.map(doc => doc.data());

  if (medicamentos.length === 0) return '💊 No hay medicamentos cargados.';

  const lista = medicamentos.map(m => {
    const proxima = calcularProximaToma(m.horarioInicio, m.frecuencia);
    return `💊 *${m.nombre}* (${m.formato})\n   ⏰ Próxima toma: ${proxima}`;
  }).join('\n\n');

  return `💊 *Medicamentos:*\n\n${lista}`;
}

async function obtenerStockBajo(userId) {
  const snapshot = await db.collection('medicamentos').where('userId', '==', userId).get();
  const bajos = snapshot.docs
    .map(doc => doc.data())
    .filter(m => m.stockActual !== null && m.stockActual <= m.stockEnvase * 0.2);

  if (bajos.length === 0) return '✅ Todos los medicamentos tienen stock suficiente.';

  const lista = bajos.map(m =>
    `⚠️ *${m.nombre}*: quedan ${m.stockActual} ${m.unidad}`
  ).join('\n');

  return `📦 *Stock bajo:*\n\n${lista}`;
}

function parsearFecha(fechaStr) {
  if (!fechaStr || !/^\d{2}\/\d{2}\/\d{4}$/.test(fechaStr)) return null;
  const [dia, mes, anio] = fechaStr.split('/').map(Number);
  return new Date(anio, mes - 1, dia);
}

function calcularProximaToma(horarioInicio, frecuencia) {
  if (!horarioInicio || !frecuencia) return 'Sin datos';
  const match = frecuencia.match(/\d+/);
  if (!match) return 'Sin datos';
  const intervaloHoras = parseInt(match[0]);
  const [horas, minutos] = horarioInicio.split(':').map(Number);
  const ahora = new Date();
  const inicio = new Date();
  inicio.setHours(horas, minutos, 0, 0);
  let proxima = new Date(inicio);
  while (proxima <= ahora) {
    proxima = new Date(proxima.getTime() + intervaloHoras * 60 * 60 * 1000);
  }
  const horaStr = proxima.getHours().toString().padStart(2, '0');
  const minStr = proxima.getMinutes().toString().padStart(2, '0');
  const esHoy = proxima.toDateString() === ahora.toDateString();
  return esHoy ? `Hoy ${horaStr}:${minStr}` : `Mañana ${horaStr}:${minStr}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
