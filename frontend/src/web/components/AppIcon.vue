<script lang="ts">
// TASK-170 W-1: the icon map's home is shared/components/AppIcon.vue (the
// shared DataRow's chevron needs it without a web dependency). This file
// re-exports it so the web import sites keep './components/AppIcon.vue'.
import AppIcon from '@/shared/components/AppIcon.vue'
export default AppIcon
export type { IconName } from '@/shared/components/AppIcon.vue'
</script>
