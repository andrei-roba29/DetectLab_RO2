import { asigHeritageResponse } from '../../backend/src/lib/asig-heritage.mjs';
export default (request) => asigHeritageResponse(request);
export const config = { path: '/api/geo/asig-heritage' };
