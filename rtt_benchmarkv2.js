/**
 * rtt_benchmarkv2.js
 * ------------------------------------------------------------
 * Mide el RTT (Round Trip Time) del ciclo completo:
 *   publicación de comando (actdata) -> actuación en el dispositivo
 *   -> confirmación de estado (sdata)
 *
 * Uso:
 *   1. Configurar las variables de entorno (ver abajo) o editar
 *      la sección CONFIG directamente.
 *   2. Ejecutar:  node rtt_benchmarkv2.js
 *   3. Los resultados se imprimen en consola y se guardan en
 *      rtt_results_<timestamp>.csv (una fila por iteración).
 *
 * Requiere: npm install mqtt   (si no está ya instalado)
 * ------------------------------------------------------------
 */

//librerias
//permite com. MQTT
const mqtt = require('mqtt');
//file system - permite trabajar con archivos - lo uso al final para guardar el CSV
const fs = require('fs');

// ============================================================
// CONFIG - ajustar antes de correr
// ============================================================
const CONFIG = {
  brokerUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  username: process.env.MQTT_USERNAME || 'benchmark',
  password: process.env.MQTT_PASSWORD || 'benchmark',

  userId: process.env.TEST_USER_ID || 'REEMPLAZAR_userId',
  deviceId: process.env.TEST_DEVICE_ID || 'REEMPLAZAR_deviceId', // el _id de Mongo del dispositivo
  actuatorId: process.env.TEST_ACTUATOR_ID || 'REEMPLAZAR_actuatorId',
//las variables de entorno normalmente llegan como string, por eso parseamos. Indicamos base 10
  iterations: parseInt(process.env.TEST_ITERATIONS || '300', 10),
  delayBetweenMs: parseInt(process.env.TEST_DELAY_MS || '1000', 10), // pausa entre ensayos
  timeoutMs: parseInt(process.env.TEST_TIMEOUT_MS || '10000', 10),   // igual al timeout que usa el frontend

  label: process.env.TEST_LABEL || 'red_degradada_n300', // ej: "baseline" o "red_degradada"
};

// ============================================================
// TOPICS
// ============================================================

// Arma userId/deviceId/actuatorId/actdata (comando) y
// .../sdata (estado). Replica el esquema de tópicos de la aplicación.
function buildTopics(cfg) {
  const base = `${cfg.userId}/${cfg.deviceId}/${cfg.actuatorId}`;

  return {
    cmdTopic: `${base}/actdata`,
    stateTopic: `${base}/sdata`,
  };
}

// ============================================================
// UTILIDADES ESTADÍSTICAS
// ============================================================

// Recibe un array ordenado de menor a mayor y un percentil
// (por ejemplo 50, 90 o 95).
//
// Devuelve el valor por debajo del cual se encuentra
// aproximadamente el porcentaje indicado de las mediciones.
// percentil -> "¿Cuál es el valor por debajo del cual está aproximadamente el x % de mis mediciones?"
//la funcion percentil toma un array ordenado, en nuestro caso de mediciones, y nos dice por ej: "el 95% de tus mediciones estan por debajo de 12ms"
// Ejemplo:
// calcularPercentil(medicionesOrdenadas, 95)
// → valor por debajo del cual se encuentra aproximadamente
//   el 95 % de las mediciones.
function calcularPercentil(medicionesOrdenadas, percentil) {
  if (medicionesOrdenadas.length === 0) return NaN;

  const indice =
    Math.ceil((percentil / 100) * medicionesOrdenadas.length) - 1;

  // Limita el índice para evitar acceder a una posición inexistente.
  return medicionesOrdenadas[
    Math.min(
      Math.max(indice, 0),
      medicionesOrdenadas.length - 1
    )
  ];
}

// Calcula la media aritmética de las mediciones.
function calcularMedia(mediciones) {
  return (
    mediciones.reduce((suma, valor) => suma + valor, 0) /
    mediciones.length
  );
}

// Calcula el desvío estándar poblacional.
//
// Indica qué tan dispersos están los RTT respecto de su media.
function calcularDesvioEstandar(mediciones, media) {
  const varianza =
    mediciones.reduce(
      (suma, valor) => suma + (valor - media) ** 2,
      0
    ) / mediciones.length;

  return Math.sqrt(varianza);
}

// Calcula el jitter como el promedio de las diferencias
// absolutas entre RTT de mediciones consecutivas.
//
// Ejemplo:
// RTT: 10, 15, 12
//
// Diferencias:
// |15 - 10| = 5
// |12 - 15| = 3
//
// Jitter:
// (5 + 3) / 2 = 4 ms
//
// Importante: se utiliza el orden temporal original de las
// mediciones. NO debe utilizarse un array ordenado.
function calcularJitter(mediciones) {
  if (mediciones.length < 2) return NaN;

  let sumaDiferencias = 0;

  for (let i = 1; i < mediciones.length; i++) {
    sumaDiferencias += Math.abs(
      mediciones[i] - mediciones[i - 1]
    );
  }

  return sumaDiferencias / (mediciones.length - 1);
}

// ============================================================
// RESUMEN ESTADÍSTICO
// ============================================================

// Recibe las muestras obtenidas durante el benchmark y calcula
// las principales métricas estadísticas de la comunicación.
function calcularEstadisticas(muestras) {
  // Extrae únicamente los RTT correspondientes a mediciones exitosas.
  const medicionesValidas = muestras
    .filter((muestra) => muestra.rtt !== null) //elimina los timeout
    .map((muestra) => muestra.rtt); //extrae solo el campo RTT de cada muestra

  // Cantidad total de mediciones realizadas.
  const muestrasTotales = muestras.length;

  // Cantidad de mediciones que recibieron respuesta.
  const muestrasExitosas = medicionesValidas.length;

  // Cantidad de mediciones que terminaron en timeout.
  const timeouts = muestrasTotales - muestrasExitosas;

  // Tasa de pérdida expresada como porcentaje.
  const tasaPerdida =
    muestrasTotales > 0
      ? (timeouts / muestrasTotales) * 100
      : 0;

  // Se ordenan de menor a mayor las mediciones para calcular percentiles,
  // mediana, mínimo y máximo.
  const medicionesOrdenadas = [...medicionesValidas].sort(
    (a, b) => a - b
  );

  // Si todas las mediciones fueron timeout, no es posible
  // calcular estadísticas de RTT.
  if (medicionesValidas.length === 0) {
    return {
      muestrasTotales,
      muestrasExitosas,
      timeouts,
      tasaPerdida,

      mediaRTT: NaN,
      medianaRTT: NaN,
      desvioEstandarRTT: NaN,
      jitterRTT: NaN,

      minimoRTT: NaN,
      maximoRTT: NaN,
      p95RTT: NaN,
    };
  }

  // Calcula la media del RTT.
  const mediaRTT = calcularMedia(medicionesValidas);

  // devuelve en forma de objeto
  return {
    // Cantidad de mediciones
    muestrasTotales,
    muestrasExitosas,
    timeouts,
    tasaPerdida,

    // Estadísticas de RTT
    mediaRTT,

    // P50 = mediana
    medianaRTT: calcularPercentil(
      medicionesOrdenadas,
      50
    ),

    // Dispersión de los RTT respecto de la media.
    desvioEstandarRTT: calcularDesvioEstandar(
      medicionesValidas,
      mediaRTT
    ),

    // Variación entre RTT consecutivos.
    // Se calcula sobre medicionesValidas, NO sobre medicionesOrdenadas.
    jitterRTT: calcularJitter(medicionesValidas),

    // Valores extremos
    minimoRTT: medicionesOrdenadas[0],
    maximoRTT:
      medicionesOrdenadas[medicionesOrdenadas.length - 1],

    // Percentil 95
    p95RTT: calcularPercentil(
      medicionesOrdenadas,
      95
    ),
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const { cmdTopic, stateTopic } = buildTopics(CONFIG);

  console.log('=== RTT Benchmark ===');
  console.log('Broker:      ', CONFIG.brokerUrl);
  console.log('Tópico cmd:  ', cmdTopic);
  console.log('Tópico state:', stateTopic);
  console.log('Iteraciones: ', CONFIG.iterations);
  console.log('Etiqueta:    ', CONFIG.label);
  console.log('---------------------------------------------');

  // Si algún ID sigue en REEMPLAZAR_*, aborta con exit(1).
  if (
    CONFIG.userId.startsWith('REEMPLAZAR') ||
    CONFIG.deviceId.startsWith('REEMPLAZAR') ||
    CONFIG.actuatorId.startsWith('REEMPLAZAR')
  ) {
    console.error(
      'ERROR: Falta configurar userId / deviceId / actuatorId. ' +
      'Editá CONFIG o las variables de entorno TEST_USER_ID, ' +
      'TEST_DEVICE_ID, TEST_ACTUATOR_ID.'
    );

    process.exit(1);
  }

  const client = mqtt.connect(CONFIG.brokerUrl, {
    clean: true,
    clientId: 'rtt_bench_' + Date.now(),
    username: CONFIG.username,
    password: CONFIG.password,
  });

  const muestras = [];

  let currentValue = true; // arrancamos encendiendo
// esperar conexion MQTT
  await new Promise((resolve, reject) => {
    client.on('connect', resolve);
    client.on('error', reject);
  });

  client.subscribe(stateTopic, { qos: 0 });

  console.log('Conectado. Iniciando mediciones...\n');

  // ==========================================================
  // EJECUCIÓN DE LAS MEDICIONES
  // ==========================================================

  // "Prepará una medición. Escuchá el tópico de estado. Enviá el comando.
  //  Si llega la respuesta correcta, calculá cuánto tardó y terminá la medición.
  //  Si no llega antes del timeout, marcala como fallida."
  for (let i = 0; i < CONFIG.iterations; i++) {
    const expectedValue = currentValue;

    // Momento exacto en que se envía el comando.
    const t0 = Date.now();

    const rtt = await new Promise((resolve) => {
    //uso settled para indicar cuando termina una medicion, ya sea cuando llega respuesta o se produce el timeout 10s
      let settled = false;
    
      //callback para cuando llega el mensaje MQTT
      // lo registramos en client.on('message', onMessage);
      // 1. Crear listener
      const onMessage = (topic, message) => {
        if (topic !== stateTopic) return;

        //intentamos interpretar el mensaje
        try {
          const parsed = JSON.parse(message.toString()); //convierte en objeto JS

          // Solo consideramos como respuesta válida el estado
          // que coincide con el valor que acabamos de solicitar.
          // A su vez, la medicion todavia tiene que estar pendiente, por eso !settled
          // Si este mensaje corresponde a lo que estamos esperando y la medición todavía no terminó...
          if (parsed.value === expectedValue && !settled) {
            settled = true; // marcamos la medicion como terminada

            //como obtuve respuesta, dejo de escuchar
            client.removeListener(
              'message',
              onMessage
            );

            clearTimeout(timer); //cancelo timeout

            // RTT = tiempo transcurrido desde el envío
            // del comando hasta la recepción de la confirmación.
            resolve(Date.now() - t0);
          }
        } catch (e) {
          // Ignorar mensajes no parseables.
        }
      };

      // Si no recibimos confirmación dentro del tiempo configurado,
      // consideramos la medición como timeout.
      //2. Crear timeout
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;

          client.removeListener(
            'message',
            onMessage
          );

          resolve(null);
        }
      }, CONFIG.timeoutMs);

      // 3. Empezar a escuchar
      client.on('message', onMessage);

      // 4. Publicar el comando.
      client.publish(
        cmdTopic,
        JSON.stringify({
          value: expectedValue,
        })
      );
    });

    // Guardamos la muestra individual.
    muestras.push({
      iteration: i + 1,
      value: expectedValue,
      rtt,
    });

    const status =
      rtt === null
        ? 'TIMEOUT'
        : `${rtt} ms`;

    console.log(
      `Iteración ${i + 1}/${CONFIG.iterations} ` +
      `(valor=${expectedValue}): ${status}`
    );

    // Alternamos ON/OFF para el siguiente ensayo.
    currentValue = !currentValue;

    // Esperamos antes de realizar la siguiente medición.
    await new Promise((resolve) =>
      setTimeout(resolve, CONFIG.delayBetweenMs)
    );
  }

  client.end(); //cierra cliente MQTT

  // ==========================================================
  // RESUMEN ESTADÍSTICO
  // ==========================================================

  const estadisticas =
    calcularEstadisticas(muestras);

  console.log('\n=== Resumen estadístico ===');
  console.log(`Etiqueta:                ${CONFIG.label}`);
  console.log(
    `Muestras totales:       ${estadisticas.muestrasTotales}`
  );
  console.log(
    `Muestras exitosas:      ${estadisticas.muestrasExitosas}`
  );
  console.log(
    `Timeouts:               ${estadisticas.timeouts}`
  );
  console.log(
    `Tasa de pérdida:        ${estadisticas.tasaPerdida.toFixed(1)} %`
  );

  console.log(
    `RTT promedio:           ${estadisticas.mediaRTT.toFixed(1)} ms`
  );
  console.log(
    `RTT mediano (P50):      ${estadisticas.medianaRTT.toFixed(1)} ms`
  );
  console.log(
    `Desvío estándar RTT:    ${estadisticas.desvioEstandarRTT.toFixed(1)} ms`
  );
  console.log(
    `Jitter promedio RTT:    ${estadisticas.jitterRTT.toFixed(1)} ms`
  );

  console.log(
    `RTT mínimo:             ${estadisticas.minimoRTT} ms`
  );
  console.log(
    `RTT máximo:             ${estadisticas.maximoRTT} ms`
  );
  console.log(
    `P95 RTT:                ${estadisticas.p95RTT} ms`
  );

  // ==========================================================
  // EXPORTACIÓN CSV
  // ==========================================================
  
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const filename =
    `rtt_results_${CONFIG.label}_${ts}.csv`;

  // Se mantienen los nombres originales del CSV para facilitar
  // su posterior procesamiento con otras herramientas.
  const header =
    'iteration,value,rtt_ms\n';

  const rows = muestras
    .map(
      (muestra) =>
        `${muestra.iteration},` +
        `${muestra.value},` +
        `${muestra.rtt === null ? 'TIMEOUT' : muestra.rtt}`
    )
    .join('\n');

  fs.writeFileSync(
    filename,
    header + rows
  );

  console.log(
    `\nCSV guardado en: ${filename}`
  );
}

// ============================================================
// MANEJO DE ERRORES
// ============================================================

main().catch((err) => {
  console.error(
    'Error ejecutando el benchmark:',
    err
  );

  process.exit(1);
});