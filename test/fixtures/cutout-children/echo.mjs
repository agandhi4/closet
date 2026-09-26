// Stand-in model processes for src/cutout/runner.spec.ts, speaking the
// protocol of src/cutout/protocol.ts. This one answers every image with a
// mask of 200s.
process.on('message', (message) => {
  if (message.type === 'load') {
    process.send({ type: 'loaded', loadMs: 1, rssMb: 10 });
  } else {
    process.send({
      type: 'mask',
      id: message.id,
      mask: new Uint8Array(message.rgb.length / 3).fill(200),
      inferenceMs: 5,
      rssMb: 11,
      maxRssMb: 12,
    });
  }
});
process.on('disconnect', () => process.exit(0));
