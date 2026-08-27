WITH target_order AS (
  SELECT
    id, tenant_id, order_no, order_source, order_type, business_type,
    company_id, fleet_id, vehicle_id, repair_shop_id,
    warm_process_instance_id, current_node_key, hq_status, driver_status,
    order_status, submitted_at, finished_at, finish_round,
    external_order_no, created_at, updated_at
  FROM work_order
  WHERE external_order_no = :waybill_no OR order_no = :waybill_no
  ORDER BY CASE WHEN external_order_no = :waybill_no THEN 0 ELSE 1 END, id DESC
  LIMIT 1
), trace_rows AS (
  SELECT
    'work_order' AS section,
    CAST(wo.id AS CHAR) AS record_id,
    wo.id AS sort_id,
    wo.created_at AS occurred_at,
    JSON_OBJECT(
      'id', CAST(wo.id AS CHAR), 'tenant_id', CAST(wo.tenant_id AS CHAR),
      'order_no', wo.order_no, 'external_order_no', wo.external_order_no,
      'order_source', wo.order_source, 'order_type', wo.order_type,
      'business_type', wo.business_type, 'company_id', CAST(wo.company_id AS CHAR),
      'fleet_id', CAST(wo.fleet_id AS CHAR), 'vehicle_id', CAST(wo.vehicle_id AS CHAR),
      'repair_shop_id', CAST(wo.repair_shop_id AS CHAR),
      'warm_process_instance_id', CAST(wo.warm_process_instance_id AS CHAR),
      'current_node_key', wo.current_node_key, 'hq_status', wo.hq_status,
      'driver_status', wo.driver_status, 'order_status', wo.order_status,
      'submitted_at', wo.submitted_at, 'finished_at', wo.finished_at,
      'finish_round', wo.finish_round, 'created_at', wo.created_at,
      'updated_at', wo.updated_at
    ) AS data
  FROM target_order AS wo

  UNION ALL

  SELECT
    'operation' AS section,
    CAST(op.id AS CHAR) AS record_id,
    op.id AS sort_id,
    op.operated_at AS occurred_at,
    JSON_OBJECT(
      'id', CAST(op.id AS CHAR), 'order_id', CAST(op.order_id AS CHAR),
      'node_key', op.node_key, 'node_name', op.node_name, 'flow_seq', op.flow_seq,
      'action', op.action, 'result', op.result, 'reason_codes', op.reason_codes,
      'reason_text', op.reason_text, 'remark', op.remark,
      'operator_id', CAST(op.operator_id AS CHAR), 'operator_name', op.operator_name,
      'operator_role', op.operator_role, 'operated_at', op.operated_at
    ) AS data
  FROM work_order_operation_record AS op
  JOIN target_order AS wo ON wo.id = op.order_id

  UNION ALL

  SELECT
    'flow_instance' AS section,
    CAST(fi.id AS CHAR) AS record_id,
    fi.id AS sort_id,
    fi.create_time AS occurred_at,
    JSON_OBJECT(
      'id', CAST(fi.id AS CHAR), 'definition_id', CAST(fi.definition_id AS CHAR),
      'business_id', fi.business_id, 'flow_name', fi.flow_name,
      'node_code', fi.node_code, 'node_name', fi.node_name,
      'flow_status', fi.flow_status, 'activity_status', fi.activity_status,
      'create_time', fi.create_time, 'update_time', fi.update_time, 'del_flag', fi.del_flag
    ) AS data
  FROM flow_instance AS fi
  JOIN target_order AS wo ON wo.order_no = fi.business_id

  UNION ALL

  SELECT
    'flow_task' AS section,
    CAST(ft.id AS CHAR) AS record_id,
    ft.id AS sort_id,
    ft.create_time AS occurred_at,
    JSON_OBJECT(
      'id', CAST(ft.id AS CHAR), 'instance_id', CAST(ft.instance_id AS CHAR),
      'node_code', ft.node_code, 'node_name', ft.node_name,
      'flow_status', ft.flow_status, 'create_time', ft.create_time,
      'update_time', ft.update_time, 'del_flag', ft.del_flag
    ) AS data
  FROM flow_task AS ft
  JOIN flow_instance AS fi ON fi.id = ft.instance_id
  JOIN target_order AS wo ON wo.order_no = fi.business_id

  UNION ALL

  SELECT
    'flow_his_task' AS section,
    CAST(fht.id AS CHAR) AS record_id,
    fht.id AS sort_id,
    fht.create_time AS occurred_at,
    JSON_OBJECT(
      'id', CAST(fht.id AS CHAR), 'instance_id', CAST(fht.instance_id AS CHAR),
      'task_id', CAST(fht.task_id AS CHAR), 'node_code', fht.node_code,
      'node_name', fht.node_name, 'target_node_code', fht.target_node_code,
      'target_node_name', fht.target_node_name, 'approver', fht.approver,
      'skip_type', fht.skip_type, 'flow_status', fht.flow_status,
      'message', fht.message, 'create_time', fht.create_time,
      'update_time', fht.update_time, 'del_flag', fht.del_flag
    ) AS data
  FROM flow_his_task AS fht
  JOIN flow_instance AS fi ON fi.id = fht.instance_id
  JOIN target_order AS wo ON wo.order_no = fi.business_id

  UNION ALL

  SELECT
    'ky_receive' AS section,
    CAST(kr.id AS CHAR) AS record_id,
    kr.id AS sort_id,
    COALESCE(kr.last_seen_at, kr.first_seen_at) AS occurred_at,
    JSON_OBJECT(
      'id', CAST(kr.id AS CHAR), 'third_code', kr.third_code, 'request_id', kr.request_id,
      'plate_no', kr.plate_no, 'vehicle_vin', kr.vehicle_vin,
      'depart_name', kr.depart_name, 'maintenance_type', kr.maintenance_type,
      'content', kr.content, 'mileage', kr.mileage, 'apply_name', kr.apply_name,
      'apply_code', kr.apply_code, 'appoint_time_text', kr.appoint_time_text,
      'position', kr.position, 'settle_company', kr.settle_company,
      'receive_status', kr.receive_status, 'receive_count', kr.receive_count,
      'first_seen_at', kr.first_seen_at, 'last_seen_at', kr.last_seen_at,
      'conflict_at', kr.conflict_at, 'error_code', kr.error_code,
      'error_message', kr.error_message, 'linked_order_id', CAST(kr.linked_order_id AS CHAR),
      'linked_at', kr.linked_at, 'routing_rule', kr.routing_rule,
      'matched_fleet_name', kr.matched_fleet_name, 'routed_at', kr.routed_at
    ) AS data
  FROM ky_work_order_receive_record AS kr
  JOIN target_order AS wo
    ON kr.linked_order_id = wo.id OR kr.third_code = wo.external_order_no

  UNION ALL

  SELECT
    'ky_push' AS section,
    CAST(kp.id AS CHAR) AS record_id,
    kp.id AS sort_id,
    COALESCE(kp.last_pushed_at, kp.triggered_at, kp.created_at) AS occurred_at,
    JSON_OBJECT(
      'id', CAST(kp.id AS CHAR), 'source_code', kp.source_code,
      'third_code', kp.third_code, 'order_no', kp.order_no,
      'receive_record_id', CAST(kp.receive_record_id AS CHAR),
      'trigger_event', kp.trigger_event, 'trigger_order_id', CAST(kp.trigger_order_id AS CHAR),
      'finish_round', kp.finish_round, 'triggered_at', kp.triggered_at,
      'planned_push_at', kp.planned_push_at, 'uuid', kp.uuid,
      'response_status_code', kp.response_status_code,
      'response_status', kp.response_status, 'response_result', kp.response_result,
      'push_status', kp.push_status, 'retry_count', kp.retry_count,
      'next_retry_at', kp.next_retry_at, 'last_error_code', kp.last_error_code,
      'last_error_message', kp.last_error_message, 'first_pushed_at', kp.first_pushed_at,
      'last_pushed_at', kp.last_pushed_at, 'success_at', kp.success_at,
      'canceled_at', kp.canceled_at, 'created_at', kp.created_at, 'updated_at', kp.updated_at
    ) AS data
  FROM ky_maintenance_result_push_record AS kp
  JOIN target_order AS wo
    ON kp.trigger_order_id = wo.id OR kp.third_code = wo.external_order_no
), ranked_trace_rows AS (
  SELECT
    section, record_id, sort_id, occurred_at, data,
    ROW_NUMBER() OVER (
      PARTITION BY section
      ORDER BY occurred_at DESC, sort_id DESC
    ) AS section_rank
  FROM trace_rows
)
SELECT section, record_id, occurred_at, data
FROM ranked_trace_rows
WHERE section_rank <= CASE section
  WHEN 'work_order' THEN 1
  WHEN 'operation' THEN 40
  WHEN 'flow_instance' THEN 10
  WHEN 'flow_task' THEN 30
  WHEN 'flow_his_task' THEN 50
  WHEN 'ky_receive' THEN 30
  WHEN 'ky_push' THEN 39
  ELSE 0
END
ORDER BY occurred_at DESC, section, sort_id DESC
LIMIT 200
