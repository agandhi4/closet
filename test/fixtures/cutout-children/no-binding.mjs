// A model process whose onnxruntime-node binding is missing (the arm64
// image): child.ts's static import throws before any message is read, and
// the process exits 1.
process.exit(1);
