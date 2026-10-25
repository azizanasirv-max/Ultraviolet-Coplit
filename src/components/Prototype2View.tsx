/**
 * Prototype 2 entry point.
 *
 * The prototype tab renders the salesperson experience only. Customers reach
 * their own route (`/join?invite=...`) which never renders this component, so
 * each participant sees a single, role-specific interface.
 */
export { SalespersonDashboard as Prototype2View, SalespersonDashboard } from './prototype2/SalespersonDashboard';
export { default } from './prototype2/SalespersonDashboard';
