SELECT
  wo.id,
  wo.order_no,
  wo.order_status,
  wo.created_at,
  (
    SELECT COUNT(*)
    FROM work_order
    WHERE created_at > :created_after
  ) AS total
FROM work_order AS wo
WHERE wo.created_at > :created_after
ORDER BY wo.created_at DESC, wo.id DESC
LIMIT 5
