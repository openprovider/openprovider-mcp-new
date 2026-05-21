import { z } from 'zod';

export const placeholderTool = {
  name: 'phase1.echo',
  description: 'Phase 1 placeholder. Echoes a message; proves transport + auth + audit wiring.',
  inputSchema: z.object({ message: z.string().min(1).max(256) }),
  handler: (input: { message: string }): Promise<{ echoed: string }> =>
    Promise.resolve({ echoed: input.message }),
};

export type PlaceholderInput = z.infer<typeof placeholderTool.inputSchema>;
