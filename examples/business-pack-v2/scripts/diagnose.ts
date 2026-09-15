const input: { id: string } = await workflow.input();
const order = await operations.call('order.find', input);

return {
  status: 'ok',
  order,
};
