export const colors = {
  white: 'white',
  dim: 'gray',
  accent: 'cyan',
  muted: 'gray',
  lowBlack: '#0A0A0A',
  surface: '#000000',
  border: '#555555',
  primary: '#00D4FF',
  secondary: '#8B5CF6',
};

export const useColor = (name: keyof typeof colors) => {
  return colors[name];
};