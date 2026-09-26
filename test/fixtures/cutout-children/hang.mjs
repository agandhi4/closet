// Loads, then never answers an image (the runner's timeout must kill it).
process.on('message', (message) => {
  if (message.type === 'load') {
    process.send({ type: 'loaded', loadMs: 1, rssMb: 10 });
  }
});
process.on('disconnect', () => process.exit(0));
