// Cannot load its model.
process.on('message', (message) => {
  if (message.type === 'load') {
    process.send({ type: 'error', message: 'invalid model file' });
  }
});
process.on('disconnect', () => process.exit(0));
