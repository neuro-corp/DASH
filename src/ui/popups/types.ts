export type PendingRequest = {
  kind: 'approval' | 'question';
  prompt: string;
  options: string[];
  resolve: (answer: string) => void;
};
